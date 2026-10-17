# Runbook: deploy de contratos sobre el fork

Deploy y verificación de los contratos del sistema sobre Anvil ([C-SCR-01], [C-SCR-02]).

Redes:

| Red | Entorno | JSON |
|---|---|---|
| `local` | Anvil del compose | `contracts/deployments/local.json` (gitignored) |
| `ci` | Anvil efímero del job de contratos | `contracts/deployments/ci.json` (gitignored) |
| `fork/staging` | ensayo de staging (P25) | `contracts/deployments/fork/staging.json` |
| `fork/production` | ensayo de producción (P30) | `contracts/deployments/fork/production.json` |

`DeployCore` se niega a transmitir si el RPC no es Anvil (`web3_clientVersion`). El deploy real en Base mainnet es otra cosa: lo hace `DeployBase` en el despliegue final ([C-SCR-04]), con hardware wallet y aprobación escrita del owner.

## Deploy local

```bash
cd wallet
pnpm fork:reset          # fork limpio en FORK_BLOCK_NUMBER (deployer con nonce 0)
pnpm deploy:core         # = bash scripts/deploy-core local
```

`scripts/deploy-core <red>` hace, en orden:

1. **Lee el entorno.** Toma de `wallet/.env` sólo las variables que necesita (`LOCAL_RPC_URL`, `DEPLOYER_KEY_SOURCE`, `GOVERNANCE_SAFE_ADDRESS`, `POLICY_GUARDIANS` y, en `local`/`ci`, `LOCAL_SEED`) y las pasa por entorno, nunca por línea de comandos.
2. **Registra el commit.** `DEPLOY_GIT_COMMIT` es `git rev-parse HEAD`. `DEPLOY_GIT_DIRTY` vale `true` si hay cambios en `contracts/` o en `config/chains/`.
3. **Fondea con `FundForkAccounts.s.sol`.** Usa `anvil_setBalance`, en una invocación de forge previa, porque la simulación on-chain de `forge script` usa el estado del bloque en que arranca:
   - en `local` y `ci`, el deployer y el creador de la Governance Safe;
   - en `fork/*`, `DEPLOYER_ADDRESS`.
4. **Despliega con `DeployCore.s.sol --broadcast --slow`.**
   - Verifica `chainId` y los codehashes de todos los contratos externos de `config/chains/base-mainnet.json`.
   - Resuelve el deployer y el admin, verifica el nonce del deployer y predice la `WalletFactory` (`CREATE` con nonce inicial + 6, §6.1).
   - Despliega en el orden de §6.1 con `SystemDeployer` (el mismo código que usan los tests).
   - Exige que la factory real sea la predicha y que su `validateConfig` dé 0.
   - Escribe el JSON de la red.
5. **Verifica con `VerifyDeployment.s.sol`** (sin transacciones).

## Variables

| Variable | `local` / `ci` | `fork/staging` / `fork/production` |
|---|---|---|
| `DEPLOY_NETWORK` | el wrapper la fija | el wrapper la fija |
| `DEPLOYER_KEY_SOURCE` | `local-seed`: el deployer se deriva de `LOCAL_SEED` | `keystore` (ensayo), o `ledger`/`trezor`; el deployer es la wallet que recibe forge (`--keystore <archivo> --password-file <archivo>`) |
| `GOVERNANCE_SAFE_ADDRESS` | opcional; si falta, se crea la Governance Safe 2-de-3 local con owners derivados | obligatoria (Safe v1.5.0 con threshold ≥ 2 y más owners que el threshold) |
| `POLICY_GUARDIANS` | opcional; si falta, dos guardianes derivados | obligatoria (separadas por coma) |
| `POLICY_MODE` | `restricted` (por defecto) o `bootstrap` | sólo `restricted` |
| `EXPECTED_DEPLOYER_NONCE` | opcional | por defecto `0` (deployer nuevo) |
| `PREDECESSOR_GUARD` | opcional (upgrade de Guard, [C-GRD-17]) | ídem |
| `DEPLOY_GIT_DIRTY` | puede ser `true` | tiene que ser `false` |

Ensayo de staging sobre el fork (P25.T06):

```bash
DEPLOYER_KEY_SOURCE=keystore \
DEPLOYER_ADDRESS=<de ~/.config/mtw/staging.env> \
GOVERNANCE_SAFE_ADDRESS=<Governance Safe de ensayo creada en el fork> \
POLICY_GUARDIANS=<guardian-1>,<guardian-2> \
bash scripts/deploy-core fork/staging \
  --keystore ~/.config/mtw/keys/staging/deployer \
  --password-file ~/.config/mtw/secrets/staging/deployer.password
```

## Cuentas locales derivadas de `LOCAL_SEED`

`script/lib/LocalKeys.sol` deriva cada clave como `keccak256("mtw-local-key" ‖ seed ‖ label)`, re-hasheada hasta caer en el rango de secp256k1. Sólo funciona contra Anvil y nunca usa las cuentas públicas de Anvil.

| Label | Uso |
|---|---|
| `deployer` | despliega los contratos del sistema |
| `governance-owner-1`, `governance-owner-2`, `governance-owner-3` | owners de la Governance Safe local 2-de-3; el 1 la crea (saltNonce `keccak256("mtw-local-governance-safe")`) |
| `guardian-1`, `guardian-2` | guardianes del `PolicyRegistry` |

## Qué verifica `VerifyDeployment`

```bash
cd wallet/contracts
DEPLOY_NETWORK=local forge script script/VerifyDeployment.s.sol --rpc-url $LOCAL_RPC_URL
```

Re-lee todo on-chain y lo compara contra el JSON y contra `config/chains/base-mainnet.json`. Hoy son 123 verificaciones; cada diferencia se reporta y el script revierte al final.

- **Contratos externos:** codehash de cada uno; dirección y codehash de la implementación de los proxies (USDC).
- **Direcciones:** cada contrato es el `CREATE` del deployer con su posición en §6.1; el `RotationTimelock` es el primer `CREATE` del Guard.
- **Código:**
  - codehash igual al del JSON;
  - runtime idéntico al artefacto compilado desde las fuentes actuales, con las posiciones de inmutables en cero;
  - compilador y settings iguales a la metadata del artefacto;
  - sin proxy.
- **Inmutables y cableado:** todos los getters de `SwapExecutorV3`, `SecurityGuard`, `RotationTimelock`, `SafeBootstrap` y `WalletFactory`, más `validateConfig`.
- **Admin:** el admin es una Governance Safe multisig.
- **Policy inicial:**
  - admin, modo y guardianes;
  - la matriz completa de permisos por opType y rol (set V1);
  - USDC y USDT con 6 decimales;
  - el executor registrado;
  - sin sucesores de Guard.
- **Argumentos de constructor:** recalculados desde los valores on-chain e iguales al JSON.

Los tests de `test/fork/DeployScripts.t.sol` alteran el JSON (codehash, dirección, argumentos, policy, nonce, compilador, chainId y bloque) y la cadena (runtime, estado del registro, código externo, implementación de USDC, threshold de la gobernanza), y exigen la cantidad exacta de fallas.

## Inspección de una Safe

```bash
bash scripts/inspect-wallet <safe> [red]
```

Muestra cada ítem contra su valor esperado y sale con 1 si alguno difiere:

- codehash del proxy, singleton, `VERSION` y nonce;
- owners contra roles del Guard y threshold;
- guard, module guard y fallback handler;
- módulos;
- `rolesOf`, `isWallet` y `verifyWallet` de la factory.

Es el chequeo manual de P05.MAN.

## Formato de `deployments/<red>.json`

`schemaVersion`, `network`, `chainId`, `forkBlock`, `block`, `timestamp`, `deployer`, `deployerNonce`, `git {commit, dirty}`, `compiler {solc, evmVersion, optimizer, optimizerRuns, viaIR, bytecodeHash, appendCBOR}`, `policy {admin, mode, guardians, v1Policy, predecessorGuard}` y, por contrato: `address`, `codehash`, `constructorArgs`, `proxy: false` e `implementation: null`.

`DeployBase` (P25) agrega los hashes de transacción, los bloques y las URLs de verificación desde los artefactos de broadcast.
