# Backend (`wallet/backend/app`)

API, worker, watcher, indexer y gas tank de MT Wallet: un solo proyecto pnpm con varios entrypoints (ADR-009, §7 del
planner). P08 deja las fundaciones: configuración validada, modelo de datos completo con migraciones, cola con outbox
transaccional, cliente RPC de quórum, logs con redacción, métricas, health, API con dos listeners, OpenAPI 3.1,
errores RFC 9457, idempotencia, rate limiting y audit log append-only con cadena HMAC.

## Requisitos

- Toolchain fijada de `wallet/.tools` (`source wallet/scripts/env.sh`): Node 26.12.0, pnpm 12.14.0, Foundry v1.8.5.
- Docker (stack local de `wallet/docker-compose.yml` y Testcontainers en los tests).
- `wallet/.env` generado por `pnpm secrets:local` y `BASE_RPC_URL` (fork de Base para Anvil).

## Uso local

```bash
cd wallet && source scripts/env.sh
docker compose up -d
cd backend/app
pnpm install --frozen-lockfile
pnpm db:migrate          # rol mtw_migrator (DDL); idempotente
pnpm dev:api             # listeners Wallet :8080 y Recovery :8081, métricas :9464
pnpm dev:worker          # dispatcher del outbox, métricas :9465
curl -s localhost:8080/api/v1/health/ready
```

`/docs` muestra Swagger UI y `/docs/openapi.json` la spec de cada listener.

| Script                                                                   | Qué hace                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `pnpm build`                                                             | compila `src/` a `dist/` (los imports `.ts` se reescriben a `.js`)                 |
| `pnpm typecheck` · `pnpm lint`                                           | TypeScript estricto · ESLint (typescript-eslint strict) + Prettier                 |
| `pnpm test`                                                              | toda la suite con cobertura (proyectos `backend` y `security`)                     |
| `pnpm test:security`                                                     | sólo P08.SEC: canarios de logs, audit_events inmodificable, CORS, rutas con schema |
| `pnpm sync:contracts` · `pnpm check:contracts`                           | copia vectores y genera ABIs desde `contracts/` · verifica que no difieran         |
| `pnpm db:migrate` · `pnpm db:status [--check]`                           | migraciones (sin "down", expand/contract)                                          |
| `pnpm db:backup [--out f]` · `pnpm db:restore --file f --confirm <base>` | backup lógico local (staging/producción: pgBackRest, ADR-031)                      |
| `pnpm audit:verify`                                                      | recalcula la cadena HMAC de `audit_events`                                         |
| `pnpm start:api` · `pnpm start:worker`                                   | entrypoints de producción sobre `dist/`                                            |

## Estructura

```text
src/
  config/        env.ts (Zod por APP_ENV, <VAR>_FILE, calidad de secretos), dotenv.ts, secret.ts
  db/            kysely.ts, schema.ts, migrator.ts, transaction.ts (withTransaction), backup.ts
    migrations/  0001_initial_schema.ts (todas las tablas de [B-DB]), grants.ts (política por rol)
    repositories/ outbox, idempotency
  audit/         audit-writer.ts (cadena HMAC, verificación)
  queue/         queues.ts, outbox-dispatcher.ts, outbox-consumer.ts, redis.ts
  chain/         rpc-quorum.ts, safe-tx.ts, eip712.ts, signatures.ts, create2.ts, decoders/, abis/ (generados)
  observability/ logger.ts, redaction.ts, metrics.ts
  api/           server.ts (dos listeners), errors.ts (RFC 9457), health.ts, routes/, plugins/
  cli/           db.ts, audit-verify.ts
  main.ts        entrypoint `api` | `worker`
test/            unit, integración (Testcontainers + Anvil), API (inject), seguridad; vectors/ (copia de contracts)
```

## Configuración

`src/config/env.ts` valida todo antes de arrancar y nunca imprime valores:

- `APP_ENV=local`: completa desde `wallet/.env` (o `MTW_ENV_FILE`); acepta `<VAR>` o `<VAR>_FILE`.
- `staging`/`production`: no lee archivos `.env`; cada secreto sólo por `<VAR>_FILE` con ruta absoluta (secrets de
  Docker Compose en `/run/secrets/…`, ADR-030); exige https y hosts no locales, `RPC_QUORUM_MODE=dual`,
  `CONFIRMATION_POLICY=tags` y proveedores RPC distintos.
- Rechaza valores de ejemplo, claves de baja entropía, passwords débiles en URLs de conexión y la clave de ejemplo de
  RFC 8032. Las variables con default figuran en `wallet/.env.example`.

## Decisiones de diseño

- **Dos listeners en un proceso** (Wallet y Recovery): cada uno con su CORS, su spec y sus rutas; el `client` sale
  del listener, nunca de un header. Un `Origin` distinto del frontend del listener recibe 403 en el servidor. Sólo se
  acepta JSON (`text/plain` no tiene parser: es un content-type que el navegador manda sin preflight).
- **Ninguna ruta sin schema**: al registrarse, toda ruta debe declarar `operationId`, `tags`, `summary`, respuesta
  2xx, errores 400/429/500/503 y body si es POST/PATCH; si falta algo el servidor no arranca.
- **Transacciones** (`withTransaction`): SERIALIZABLE por defecto y reintento ante 40001/40P01 con backoff. El
  callback puede ejecutarse más de una vez: los efectos externos van por el outbox.
- **Auditoría [B-AUD]**: `pg_advisory_xact_lock` + lectura de la cabeza + `nextval` bajo el lock;
  `entry_hash = HMAC(AUDIT_CHAIN_KEY, prev_hash ‖ JCS(entrada))`. En REPEATABLE READ/SERIALIZABLE la transacción debe
  abrirse con `withTransaction(db, fn, { auditLock: true })`, que toma `LOCK TABLE audit_chain_lock` antes del
  snapshot (si no, la cabeza leída podría ser vieja); `append` lo verifica. `audit_events` rechaza UPDATE, DELETE y
  TRUNCATE (trigger para el dueño y GRANTs para `mtw_app`).
- **Outbox [B-Q-01]**: el evento se escribe con el cambio de estado; el dispatcher publica con
  `jobId = <aggregateId>-<outboxEventId>` (deduplica la republicación del mismo evento sin descartar eventos nuevos
  del mismo agregado), corta el lote ante la primera falla con timeout de publicación y re-encola desde Postgres lo
  publicado y no procesado si Valkey pierde su estado (marcador de época) o si un job desaparece (barrido). El
  consumidor confirma con `processed_at`.
- **RPC [B-RPC]**: lecturas sensibles en el bloque común `min(heads) - 1` de ambos proveedores, comparadas; desacuerdo
  persistente → `RPC_DISAGREEMENT` sin decidir. Escrituras a ambos.
- **Rate limit [B-RL]**: store en Valkey compartido por réplicas; límite global por IP y listener, y políticas por
  acción con buckets por IP, email, usuario, sesión, Safe o propuesta (claves hasheadas). Fail-closed: Valkey caído → 503.
- **Redacción [B-OBS]**: en profundidad por nombre de clave, más IP truncada, email enmascarado y limpieza de
  credenciales en strings; los mismos tests de canario cubren logs directos, requests reales y errores.

## Tests

`pnpm test` levanta PostgreSQL 18.6 y Valkey 9.2 con las imágenes fijadas de `scripts/tools/versions.json` y el mismo
`infra/local/postgres/init-db.sh` del stack local; cada archivo clona su propia base desde una plantilla migrada. Los
tests de cadena levantan Anvil sobre el fork de Base (`BASE_RPC_URL` o `FORK_RPC_URL`; en local se lee de
`wallet/.env`) y el cliente de quórum se prueba con dos Anvil y un proxy de inyección de fallas. Cobertura: ≥ 90 % de
líneas en `src/chain/` (§10); `main.ts` y las CLIs se prueban como procesos reales.
