# Contratos del sistema

Proyecto Foundry de los contratos on-chain: se creó en P03 y se implementó entre P04 y P07. El deploy definitivo en Base mainnet lo hace `DeployBase` en el despliegue final (P25/P30). La especificación está en §6 del planner y las decisiones en `docs/adr/`.

| Ruta | Contenido |
|---|---|
| `src/` | `SecurityGuard`, `RotationTimelock`, `SafeBootstrap`, `WalletFactory`, `PolicyRegistry`, `DestinationWhitelist`, `DenyAllModuleGuard`, `SwapExecutorV3`, `libraries/` e `interfaces/` |
| `test/unit/` | tests unitarios y fuzz de librerías y contratos sin dependencias |
| `test/integration/`, `test/fork/` | integración sobre el fork de Base, con la Safe v1.5.0 real y los contratos externos del bloque fijado |
| `test/adversarial/` | un contrato por ataque, que demuestra que el ataque falla (P07.T01) |
| `test/invariant/` | invariantes A1–A17 con handler (P07.T02) |
| `test/vectors/` | vectores cruzados para backend, signer y frontends (P07.T05); en `wire/`, los de los formatos de intercambio [W-01]–[W-07] (§7.15) |
| `out-abi/` | ABIs exportadas para los consumidores (P07.T06) |
| `script/` | `DeployCore`, `VerifyDeployment`, `DeployLocal`, `SeedLocal`, `FundForkAccounts`, `QuoteReference` y librerías de scripts |
| `deployments/` | `local.json` y `ci.json` (gitignored); ensayos en `fork/` |

## Comandos

```bash
cd wallet/contracts
forge build --sizes
POLICY_MODE=restricted forge test --profile ci     # suite completa (también POLICY_MODE=bootstrap)
node ../ci/scripts/coverage-gate.mjs contracts     # cobertura con umbrales
slither . --config-file slither.config.json --fail-medium
bash script/export-abis.sh                         # out-abi/
bash script/export-vectors.sh                      # test/vectors/
bash script/verify-deps.sh                         # dependencias Soldeer contra las fuentes oficiales
```

Los fork tests usan `FORK_RPC_URL` (en CI, el secret `BASE_RPC_URL`) o, si no está definida, el Anvil local. Con el Anvil local hay que correrlos con `--threads 1`.

## Deploy sobre el fork

Ver `docs/runbooks/deploy.md`.

```bash
cd wallet
pnpm fork:reset && pnpm deploy-local && pnpm seed-local
bash scripts/inspect-wallet <safe>
```
