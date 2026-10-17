# Runbook: fork de Base

El entorno local, CI, staging y producción del planner corren sobre un fork de Base mainnet (chainId 8453) fijado en un bloque **finalizado**: hoy `52700000` (`config/chains/base-mainnet.json`, `fork.blockNumber`). Todo el estado externo (Safe, USDC, USDT, Uniswap) se verifica por codehash en ese bloque.

## Operación diaria

```bash
cd wallet
pnpm fork:start    # levanta sólo Anvil y espera eth_chainId == 0x2105
pnpm fork:reset    # anvil_reset al bloque fijado; verifica forkBlockNumber y eth_blockNumber
pnpm fork:stop
bash scripts/verify-external --block 52700000   # codehash de cada contrato externo en el bloque
```

Los fork tests de Foundry no dependen del Anvil local: hacen `vm.createSelectFork(FORK_RPC_URL, <bloque del JSON>)` (en CI `FORK_RPC_URL` es el RPC archive; en local, `ci/scripts/ci-contracts.sh` lo toma de `BASE_RPC_URL` de `wallet/.env`) y Foundry cachea las respuestas en `~/.foundry/cache/rpc/base/<bloque>`.

Para correrlos contra el Anvil local (`--fork-url "$LOCAL_RPC_URL"` sin `FORK_RPC_URL`), usar `--threads 1`: el Anvil del compose reenvía cada lectura histórica al RPC remoto y una ráfaga de pedidos en paralelo puede saturarlo.

Si el Anvil del compose deja de responder (por ejemplo, tras una ráfaga de pedidos en paralelo hacia un RPC lento), `docker compose restart anvil` y `pnpm fork:reset`.

## Cambiar `FORK_BLOCK_NUMBER`

Sólo con un motivo concreto (una dependencia nueva, liquidez insuficiente, un upgrade de Base). Un commit dedicado, nunca mezclado con otros cambios.

1. **Elegir el bloque:** uno ya `finalized` (`cast block finalized --field number --rpc-url "$BASE_RPC_URL"`), con margen respecto del head.
2. **Registrar el bloque:** en `config/chains/base-mainnet.json` actualizar `fork.blockNumber`, `fork.blockHash` (`cast block <n> --field hash`) y `fork.timestamp`; en `wallet/.env` y `.env.example`, `FORK_BLOCK_NUMBER`.
3. **Re-verificar las dependencias externas:** `bash scripts/verify-external --block <n>`. Si un codehash cambió (por ejemplo, una implementación nueva de USDC), revisar el cambio contra la fuente oficial antes de actualizar el JSON (`docs/EXTERNAL_CONTRACTS.md`, política ante cambios de implementación).
4. **Re-verificar la liquidez** del pool USDC/USDT 0,01 % (`liquidity()` y saldos) y la cotización de QuoterV2 para los montos de los tests de swap (P06).
5. **Correr la suite:** `node scripts/preflight.d/validate-chain-config.mjs`, `pnpm preflight` (PF-14, PF-15 y PF-17), `forge test` en `contracts/` (incluye `test/fork/ExternalContracts.t.sol`) y `pnpm ci:local`.
6. **Caché:** la clave de la caché RPC de CI incluye el bloque, así que se invalida sola; en local se puede borrar `~/.foundry/cache/rpc/base/<bloque viejo>`.
7. **Commit dedicado** `chore(contracts): move fork to block <n>` con el resultado de la verificación en el Registro de ejecución del planner (§13).

## Advertencia: upgrade Denim de Base

Base anunció el upgrade **Denim** (bloques de **200 ms**) con mainnet previsto para **noviembre de 2026**. Antes de mover el fork a un bloque posterior a Denim:

- Verificar que la versión de Anvil fijada (Foundry v1.8.5) soporta el hardfork y reproduce correctamente esos bloques; si no, actualizar Foundry primero (`scripts/tools/versions.json`, ADR-032) y repetir el preflight.
- Ajustar `--block-time` del servicio `anvil` en `docker-compose.yml` (hoy 2 s) y los parámetros de confirmación locales (`CONFIRMATION_DEPTH`, `FINALIZATION_DEPTH`, `confirmations.localDepth` del JSON): con bloques de 200 ms la misma profundidad en bloques representa 10 veces menos tiempo.
- En staging y producción no se usan umbrales por cantidad de bloques: rigen las tags `safe` y `finalized` (ADR-018), que no dependen del tiempo de bloque.
