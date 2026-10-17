# Snapshots de policy firmados [B-POL-01]

Cada entorno tiene `config/policy/<entorno>/policy-snapshot.json` y su firma `policy-snapshot.json.sig` (Ed25519 sobre
los bytes exactos del archivo, base64). Lo cargan el signer (P11) y el backend (P13): rechazan una firma inválida, un
snapshot de otro entorno o una versión menor a la vigente (anti-rollback, registrado en la DB de cada uno).

## Contenido

`format` (`mtw-policy-snapshot`), `formatVersion` (1), `version` (monótona), `environment`, `platformId`, `chainId`
(8453), `issuedAt`, `contracts` (Guard, timelock, factory, bootstrap, PolicyRegistry, whitelist, DenyAllModuleGuard,
SwapExecutor, SafeL2 y SafeProxyFactory), `tokens` (USDC y USDT, 6 decimales), `operations` (operaciones habilitadas
por rol, [B-POL-03]), `limits` (por operación, 24 h, umbral de 2FA, swap y mínimo — ADR-025), `swap` (slippage y
deadline), `session` (antigüedad máxima de una firma y tolerancia de reloj), `gas` (topes de fee y gas de la tx de S) y
`gasTank` (tope por recarga, tope diario y gas máximo de la cuenta gas tank). El schema exacto está en
`backend/signer/src/policy/snapshot.ts`.

## Local

El snapshot local sale del deploy local (`contracts/deployments/local.json`, que depende de `LOCAL_SEED`) y se firma
con la clave local de policy de cada desarrollador (`POLICY_SIGNING_PRIVATE_KEY_LOCAL`, generada por
`pnpm secrets:local`), así que **no se versiona** (`config/policy/local/` está en `.gitignore`):

```bash
pnpm deploy-local
pnpm --dir backend/signer policy:build      # versión + 1 sólo si el contenido cambió
pnpm --dir backend/signer policy:sign
pnpm --dir backend/signer policy:verify config/policy/local/policy-snapshot.json
```

## Staging y producción

Se generan en P25.T07, cuando existen sus direcciones (`contracts/deployments/fork/<entorno>.json`), con
`policy:build --env <entorno>` y se firman con la clave de policy del entorno guardada fuera del repo
(`policy:sign --key-file ~/.config/mtw/secrets/<entorno>/policy-signing.key`); esos sí se versionan. En el despliegue
final se re-firman offline con la clave del equipo de seguridad.
