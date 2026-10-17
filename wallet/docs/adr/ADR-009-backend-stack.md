# ADR-009 — Stack del backend

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-009), §0.1 (R-10), §3.6, §7 (introducción), §7.3 ([B-DB]), §7.11 ([B-API]), P01.T05, P08; prompt §5, §19, §20, §44

## Contexto

El prompt §5 fija preferencias de stack: backend en TypeScript, PostgreSQL, una cola con worker sobre Redis, OpenAPI + Swagger UI y Playwright para E2E; además prohíbe fijar versiones de memoria: hay que verificar las estables vigentes en fuentes oficiales y fijar versiones exactas (también R-10). El prompt §19 pide una API versionada `/api/v1` con schemas de request, response y error, autenticación, autorización, rate limits e idempotencia; el §20, Swagger en `/docs` que permita probar endpoints seguros en desarrollo sin exponer operaciones sensibles en producción; el §44, OpenAPI generado desde el código.

El backend tiene requisitos de concurrencia fuertes: asignación de nonces con lock de fila, transiciones de estado con fencing e índices únicos parciales (ADR-020, ADR-021). Las versiones de §3.6 se verificaron el 2026-10-16 contra el registry de npm y se re-verifican y fijan exactas en P01.

## Decisión

Backend en TypeScript: **Node 26 LTS** (ADR-028), **Fastify 5 + Zod 4 + fastify-type-provider-zod** (OpenAPI 3.1 generado desde el código) **+ Swagger UI**; **Kysely + pg**; **BullMQ sobre Valkey** (ADR-027); **pino**; **prom-client**; **jose**.

Versiones verificadas en §3.6, a fijar exactas en P01.T01:

| Componente | Versión |
|---|---|
| Fastify · @fastify/swagger · @fastify/swagger-ui | 5.12.7 · 9.9.2 · 6.1.2 |
| @fastify/cookie · helmet · cors · rate-limit | 11.1.3 · 13.2.0 · 11.3.1 · 11.2.1 |
| zod · fastify-type-provider-zod | 4.6.7 · 7.0.0 |
| kysely · pg | 0.29.6 · 8.23.1 |
| bullmq · ioredis | 6.3.15 · 6.0.0 |
| pino · prom-client | 10.4.0 · 15.1.3 |
| @node-rs/argon2 · otpauth · nodemailer | 2.2.2 · 9.5.2 · 10.1.2 |
| @serenity-kit/opaque · viem | 1.1.0 · 2.57.7 |
| TypeScript | 6.0.3 |
| Vitest · testcontainers (+ módulos postgresql/redis) | 5.0.5 · 12.2.1 |
| ESLint · typescript-eslint · Prettier | 10.13.0 · 8.71.2 · 3.9.10 |

`jose` 6.2.12 está fijado en §3.6 (JWS EdDSA de [B-PSES-04]) y se instala con versión exacta al crear el proyecto (R-10, P08.T01).

Organización (§7, P08):

- `wallet/backend/app` es un solo package con varios entrypoints: API, worker, watcher, indexer y gas tank. `wallet/backend/signer` y `wallet/backend/integrity-monitor` son proyectos independientes (ADR-001, ADR-014, ADR-023).
- Servidor Fastify con dos listeners (Wallet 8080 / Recovery 8081) y `client` derivado del listener; helmet; CORS estricto por listener; límites de body; errores RFC 9457 (`application/problem+json`); `requestId` (P08.T08).
- Convenciones de la API ([B-API]): JSON, paginación por cursor, `Idempotency-Key` obligatorio en los POST que crean recursos u operaciones (24 h), OpenAPI 3.1 desde los schemas Zod de cada ruta.
- Migraciones con Kysely Migrator (archivos TypeScript con SQL explícito), patrón expand/contract; roles de base `mtw_migrator`, `mtw_app` y `mtw_readonly` ([B-DB]).
- Política de supply chain por proyecto: `save-exact=true`, edad mínima de publicación de paquetes (≥ 7 días), scripts de instalación bloqueados salvo allowlist, `strict-peer-dependencies=true` y `--frozen-lockfile` en CI (P01.T05).

## Alternativas consideradas

- **NestJS:** descartado por sumar superficie y depender de decoradores (§4).
- **TypeScript 7.0.2** (el `latest` del registry): descartado porque typescript-eslint 8.71.2 exige `<6.1.0`; se fija 6.0.3 (§3.6).

Fastify se elige por rendimiento, validación por schemas y plugins oficiales; Kysely, por el control explícito del SQL y de los locks (§4).

## Consecuencias

- La especificación OpenAPI se genera desde el código y no puede divergir del runtime: hay un test que falla si una ruta no tiene schema de request, response y errores (P08.T09) y un snapshot versionado en `docs/openapi/v1.json` (P29.T03).
- Swagger UI se comporta según el entorno (§7.11): en local y staging, "Try it out" con cookie + CSRF y, para endpoints críticos, firma con la session key que se obtiene por el flujo real (`dev:session`, sin endpoints backdoor); en producción, sólo la spec de la API pública y "Try it out" deshabilitado.
- El SQL explícito permite `SELECT … FOR UPDATE`, transacciones `SERIALIZABLE` con reintento ante `40001` e índices únicos parciales, que sostienen el manejo de nonces y estados (P08.T04, ADR-020).
- La configuración se valida con Zod por `APP_ENV`, acepta `<VAR>_FILE` para todo secreto y lo exige en staging y producción (P08.T02, ADR-030); el mismo patrón se replica, implementado por separado, en el signer y el integrity monitor.
- Fijar TypeScript en 6.0.3 por compatibilidad con typescript-eslint obliga a revisar esa compatibilidad antes de cualquier upgrade de major.

## Verificación

- P01.T01 — versiones exactas registradas en `docs/VERSIONS.md` sin rangos.
- P01.T05 — `node scripts/check-pnpm-policy.mjs` confirma la política de supply chain en cada proyecto.
- P01.TST — falla si algún `package.json` bajo `wallet/` contiene rangos de versión.
- P08.T01 — `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint`.
- P08.T02 — tests de configuración (faltante, formato inválido, valor de ejemplo en producción → error).
- P08.T03 y P08.T04 — migraciones sobre PostgreSQL 18 con Testcontainers y repositorios con reintento ante `40001`.
- P08.T08 — dos listeners y CORS estricto (`test/api/server-cors.test.ts`).
- P08.T09 — OpenAPI 3.1 y cobertura de schemas (`test/api/openapi-coverage.test.ts`).
- P08.T10 y P08.T11 — idempotencia y rate limiting con store en Valkey.
- P08.TST y P08.SEC — suite de fundaciones y chequeos de seguridad del backend.
- P29.T03 — `docs/openapi/v1.json` coincide con la spec generada en runtime.
- Trazabilidad: RQ-21, RQ-49, RQ-50, RQ-74.
