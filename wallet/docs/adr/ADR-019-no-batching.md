# ADR-019 — Sin batching en V1

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-019), §0.1 (R-12), §2.2, §6.4 ([C-GRD-03]), §7.6 ([B-Q-05]), §7.10 ([B-SIG-05]); V9 §7, §9, §10; prompt §14; CF-05

## Contexto

El prompt §14 pide analizar el batching de operaciones e implementarlo si ahorra gas o latencia sin debilitar el orden de nonces, la atomicidad, la policy ni el aislamiento de fallas; si agrega complejidad o riesgo relevante, V1 puede ejecutar de a una operación, siempre que el planner justifique la decisión.

V9 impone tres restricciones que condicionan el análisis: cada Safe usa una S distinta (V9 §7), el camino asistido exige `msg.sender = S` (V9 §9) y DELEGATECALL no está permitido en el camino asistido (V9 §10). CF-05 registra el conflicto entre el pedido de analizar batching y esas restricciones.

## Decisión

**Sin batching en V1**: una `execTransaction` por transacción; ejecución en paralelo entre Safes y secuencial dentro de cada Safe.

Detalle:

- El worker procesa en paralelo **entre** Safes, con concurrencia configurable (default 8), y en forma secuencial **dentro** de cada Safe ([B-Q-05]), respetando el orden estricto de nonces (ADR-020).
- Cada transacción la firma y la transmite la S de esa Safe, con `to == safe asociada` y selector `execTransaction` ([B-SIG-05]).
- El swap, que necesita approve + swap, se resuelve con dos SafeTx consecutivas y no con un batch (ADR-015).

## Alternativas consideradas

- **Batching entre Safes (una transacción que ejecute operaciones de varias Safes):** imposible, porque cada Safe tiene una S distinta y el Guard exige `msg.sender == S` ([C-GRD-03]).
- **Batching dentro de una Safe (MultiSend):** requiere DELEGATECALL, prohibido en el camino asistido.
- **Batching en general para ahorrar gas:** Base es barato y el riesgo no compensa el ahorro (§4, CF-05).

## Consecuencias

- Se preservan el orden estricto de nonces, el aislamiento de fallas y la evaluación de policy por operación: una operación que falla no arrastra a otras.
- No hay ahorro de gas por agrupación: cada operación es una transacción propia, y un swap implica dos transacciones (approve y swap).
- Habilitar batching en el futuro exigiría cambiar el modelo CALL-only del camino asistido o el de una S por Safe, lo cual es un cambio de arquitectura y no se hace durante la ejecución del planner (R-12).

## Verificación

- P13.T09 — decisión de batching documentada y test de que el worker procesa Safes distintas en paralelo y una misma Safe en orden (`test/worker/parallelism.test.ts`).
- P13.T04 — worker con el pipeline de 12 pasos y concurrencia entre Safes.
- P13.TST.c — dos workers sobre la misma operación: sólo el dueño del lease transmite.
- P07.T01.b — DELEGATECALL en camino asistido → revert.
- Trazabilidad: RQ-44.
