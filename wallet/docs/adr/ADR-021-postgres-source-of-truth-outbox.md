# ADR-021 — PostgreSQL como fuente de verdad y outbox hacia BullMQ

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-021), §5.3, §7.3 ([B-DB]), §7.4 ([B-SM-01], [B-SM-02]), §7.6 ([B-Q-01], [B-Q-04]), §7.12 ([B-MAIL-01]), §7.14 ([B-OBS]); prompt §13, §14, §15

## Contexto

El prompt §14 define el flujo de una operación firmada como U → backend → DB → cola → worker S, y el §13 pide persistir cada operación en `wallet_operations` con estados explícitos y transiciones auditadas. El §15 exige no confiar únicamente en la memoria del worker. La cola elegida es BullMQ sobre Valkey (ADR-009, ADR-027), que es un transporte en memoria con persistencia configurable: si la cola fuera la fuente de verdad, una pérdida de Valkey podría perder o duplicar operaciones.

## Decisión

PostgreSQL es la fuente de verdad; un outbox transaccional alimenta BullMQ; la cola es sólo transporte.

Detalle:

- **Outbox transaccional** ([B-Q-01]): el cambio de estado y el evento `OPERATION_QUEUED` se escriben en la misma transacción. Un dispatcher (`backend/app/src/queue/outbox-dispatcher.ts`) publica en BullMQ (`queue: wallet-operations`, `jobId = operationId` para deduplicar) y marca `dispatched_at`. Si Valkey se pierde, el dispatcher re-encola desde PostgreSQL.
- **Transiciones** ([B-SM-01], [B-SM-02]): `transitionOperation` actualiza el estado con control de `lease_version` e inserta `audit_events` y `outbox_events` en la misma transacción; toda transición queda auditada (`OPERATION_<ESTADO>`).
- **Tabla** ([B-DB]): `outbox_events` (id bigserial, aggregate_type, aggregate_id, event_type, payload jsonb, created_at, dispatched_at, attempts) con índice `idx(dispatched_at NULLS FIRST, id)`.
- **Recuperación** ([B-Q-04]): al arrancar, el worker reclama operaciones `VALIDATING`, `READY` o `SUBMITTED` con lease vencido; las `SUBMITTED` se reconcilian contra la cadena por `chain_transactions` antes de retransmitir.
- **Emails:** también salen por el outbox (`email_outbox` lógico en `outbox_events`) con reintentos ([B-MAIL-01]).
- **Valkey:** configurado con AOF y `maxmemory-policy noeviction` (§5.3, ADR-027).

## Alternativas consideradas

- **Usar la cola como fuente de verdad del estado de las operaciones:** descartado; con PostgreSQL como fuente de verdad, la pérdida de Valkey no pierde operaciones (§4).

## Consecuencias

- Un flush o una pérdida de Valkey se recupera re-encolando desde PostgreSQL, sin pérdida ni duplicados (deduplicación por `jobId`).
- El dispatcher es un componente más para operar: se mide el lag del outbox y se alerta si supera 60 s ([B-OBS]).
- Cada transición de estado, su evento de auditoría y su evento de outbox son atómicos: no hay estados sin auditar ni trabajos encolados sin estado persistido.
- Un reinicio del backend o del worker no depende de nada en memoria.

## Verificación

- P08.T12 — audit writer con cadena HMAC y outbox dispatcher con BullMQ (`test/queue/outbox.test.ts`).
- P08.TST — integración de outbox, migraciones y repositorios.
- P13.T01 — `transitionOperation` con tabla de transiciones permitidas y prohibidas.
- P13.T04 — worker con recuperación tras crash.
- P13.TST.g — crash del proceso en cada paso del pipeline (kill -9 y reinicio) y reinicio del backend.
- P13.TST.h — flush de Valkey: el outbox re-encola sin pérdida ni duplicados.
- P26.T06 — reinicio de Valkey sin pérdida de operaciones en el ensayo local de producción.
- P24.T01 — reglas de alerta de [B-OBS], incluido el lag del outbox.
- Trazabilidad: RQ-42, RQ-43.
