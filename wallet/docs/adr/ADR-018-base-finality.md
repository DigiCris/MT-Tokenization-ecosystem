# ADR-018 — Política de finalidad en Base

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-018), §3.1, §3.5 (Base finalidad, Anvil), §7.4 ([B-SM-03]), §7.7 ([B-FIN-01] a [B-FIN-04]), §7.11 ([B-API-SCH]), P03.T06; prompt §16

## Contexto

El prompt §16 prohíbe marcar una operación como definitiva apenas llega el receipt: pide estados `SUBMITTED`, `MINED` y `CONFIRMED`, una política de confirmaciones específica para Base y el manejo de reorgs, receipts que desaparecen, hashes de bloque que cambian, transacciones reemplazadas o descartadas e inconsistencias entre RPCs, con reconciliación periódica entre base de datos y cadena.

Hechos verificados (§3.1, §3.5): según la documentación oficial de Base, un bloque L2 tarda ~2 s, la inclusión en un batch de L1 ~2 min (nunca reorgeado) y la finalidad de L1 ~20 min; el lag observado de `safe` y `finalized` respecto de `latest` fue de 24–92 s y ~19–20 min. El upgrade **Denim** (bloques de 200 ms) apunta a mainnet en noviembre de 2026, por lo que medir confirmaciones por cantidad de bloques dejaría de tener el mismo significado. Anvil 1.5.1 ofrece `anvil_reorg`, `anvil_rollback` y los tags `safe`/`finalized`.

## Decisión

Finalidad en Base: `SUBMITTED` → `MINED` (receipt) → `CONFIRMED` (bloque ≤ head `safe` y hash re-verificado por quórum; típico 1–2 min) → `FINALIZED` (bloque ≤ head `finalized`; ~20 min). **Sin umbrales por cantidad de bloques en mainnet** (Denim: bloques de 200 ms). En local y en el fork, la profundidad es configurable.

Detalle ([B-FIN]):

- **Política** ([B-FIN-01]): `CONFIRMATION_POLICY=tags` en staging y producción: CONFIRMED = bloque ≤ head `safe` y FINALIZED = bloque ≤ head `finalized`, siempre con el `block_hash` reconfirmado por quórum (ADR-017). En `MINED` se guardan `block_number` y `block_hash`.
- **Local/fork** ([B-FIN-04]): Anvil no modela batches de L1, así que se usa `CONFIRMATION_POLICY=depth` con `CONFIRMATION_DEPTH` y `FINALIZATION_DEPTH` configurables; los reorgs se prueban con `anvil_reorg` y `anvil_rollback`.
- **Watcher** ([B-FIN-02], `backend/app/src/chain/watcher.ts`, cada bloque/2 s): para toda operación o tx no finalizada verifica receipt y hash de bloque; detecta receipt desaparecido, hash de bloque cambiado, tx reemplazada o descartada (el nonce de S avanzó sin nuestro hash) e inconsistencias entre RPCs. Acciones: `REORGED` → re-encolar y retransmitir la **misma** SafeTx; `DROPPED` → retransmitir o reemplazar; inconsistencia → reintento y alerta, sin transición hasta lograr consistencia.
- **Reconciliación** ([B-FIN-03]): cada 60 s para wallets con operaciones no finales, y completa una vez por día (nonce de la Safe, roles del Guard, configuración de la Safe, whitelist, rotaciones pendientes y saldos); toda discrepancia genera un evento de auditoría y una alerta. Las transacciones soberanas se indexan desde los eventos de SafeL2.
- **Estados estables** ([B-SM-03]): CONFIRMED es estable, pero el watcher lo sigue hasta FINALIZED. La API expone `confirmations: {safe: bool, finalized: bool}` en `OperationStatus` ([B-API-SCH]).
- `config/chains/base-mainnet.json` incluye el campo `confirmations` (P03.T01).

## Alternativas consideradas

- **Umbrales por cantidad de bloques:** descartados para mainnet; con Denim los bloques pasan a 200 ms y un número fijo de bloques dejaría de representar el mismo tiempo o la misma garantía (§3.5).
- **Considerar definitiva una operación al recibir el receipt:** prohibido por el prompt §16.

## Consecuencias

- La política no depende del tiempo de bloque y se apoya en tags nativos del proveedor, re-verificados por quórum.
- FINALIZED tarda ~20 min: la UI muestra los estados intermedios (MINED, CONFIRMED, FINALIZED) en la actividad.
- Un reorg devuelve la operación a la cola y se retransmite la misma SafeTx, que sigue siendo válida mientras su nonce no se consuma (ADR-020).
- Antes de mover el fork a un bloque posterior a Denim, hay que verificar la compatibilidad de la versión fijada de Anvil y ajustar `--block-time` y los parámetros de confirmación locales (P03.T06).
- Se alerta ante reorgs detectados y desacuerdos sostenidos de RPC ([B-OBS]).

## Verificación

- P03.T01 — `config/chains/base-mainnet.json` con el campo `confirmations`, validado contra su JSON Schema.
- P03.T06 — runbook del fork con la advertencia de Denim.
- P13.T06 — watcher de finalidad y reorgs (`test/resilience/reorg.test.ts`).
- P13.T07 — reconciliador, indexado de transacciones soberanas e indexer de `Transfer` con confirmaciones y reorg.
- P13.TST.f — reorg con `anvil_reorg`: MINED → REORGED → re-ejecución de la misma SafeTx; CONFIRMED → FINALIZED.
- P18.T08 — actividad con estados MINED, CONFIRMED y FINALIZED.
- P22.T02.o — E2E de estados hasta FINALIZED.
- P23.T02 — reorg durante una operación en el acceptance → REORGED → re-ejecución correcta.
- P24.T02 — alerta de reorg provocada en local.
- P27.T02.m — auditoría de reorgs.
- Trazabilidad: RQ-46.
