# Backend (`wallet/backend/app`)

API, worker, watcher, indexer y gas tank de MT Wallet: un solo proyecto pnpm con varios entrypoints (ADR-009, §7 del
planner). P08 deja las fundaciones: configuración validada, modelo de datos completo con migraciones, cola con outbox
transaccional, cliente RPC de quórum, logs con redacción, métricas, health, API con dos listeners, OpenAPI 3.1,
errores RFC 9457, idempotencia, rate limiting y audit log append-only con cadena HMAC. P09 agrega la cuenta
centralizada [B-AUTH] (registro y verificación de email, login, sesiones, CSRF, olvido y reset de contraseña, fuerza
bruta y señales de riesgo, TOTP) y el email transaccional [B-MAIL] (Mailgun o SMTP/Mailpit por el outbox). P10, la
PlatformSession [B-PSES]: desbloqueo de la Wallet por OPAQUE con AuthSecret_U, step-up con email OTP (+ TOTP), tokens
JWS EdDSA de 15 min atados a una session key P-256 y requests críticos firmados.

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
pnpm dev:worker          # dispatcher del outbox y worker de email, métricas :9465
pnpm dev:gas-tank        # recargas de las S por el shard `platform` del signer, métricas :9466
curl -s localhost:8080/api/v1/health/ready
```

`/docs` muestra Swagger UI y `/docs/openapi.json` la spec de cada listener. En local los emails salen por SMTP a
Mailpit (`EMAIL_PROVIDER=smtp`, `SMTP_HOST`/`SMTP_PORT` del stack) y se leen en `http://localhost:8025`; con
`EMAIL_PROVIDER=mailgun` salen por la API real de Mailgun.

| Script                                                                   | Qué hace                                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `pnpm build`                                                             | compila `src/` a `dist/` (los imports `.ts` se reescriben a `.js`)                |
| `pnpm typecheck` · `pnpm lint`                                           | TypeScript estricto · ESLint (typescript-eslint strict) + Prettier                |
| `pnpm test`                                                              | toda la suite con cobertura (proyectos `backend` y `security`)                    |
| `pnpm test:security`                                                     | seguridad (P08.SEC/P09.SEC): logs, auditoría, CORS, schemas, CSRF, sesiones, auth |
| `pnpm test:live`                                                         | contra servicios reales con cuota: Mailgun (sandbox) y Gmail API (`EMAIL_TEST_*`) |
| `pnpm sync:contracts` · `pnpm check:contracts`                           | copia vectores y genera ABIs desde `contracts/` · verifica que no difieran        |
| `pnpm db:migrate` · `pnpm db:status [--check]`                           | migraciones (sin "down", expand/contract)                                         |
| `pnpm db:backup [--out f]` · `pnpm db:restore --file f --confirm <base>` | backup lógico local (staging/producción: pgBackRest, ADR-031)                     |
| `pnpm audit:verify`                                                      | recalcula la cadena HMAC de `audit_events`                                        |
| `pnpm opaque:setup`                                                      | genera `OPAQUE_SERVER_SETUP` en `wallet/.env` (sólo local; nunca reemplaza uno)   |
| `pnpm dev:session [--method --path --body] [--print]`                    | material de PlatformSession para Swagger (sólo local, ver abajo)                  |
| `pnpm signer:reassign <archivo>`                                         | aplica una migración entre shards del signer (salida de `shard:migrate`)          |
| `pnpm start:api` · `pnpm start:worker` · `pnpm start:gas-tank`           | entrypoints de producción sobre `dist/`                                           |

## Estructura

```text
src/
  config/        env.ts (Zod por APP_ENV, <VAR>_FILE, calidad de secretos), dotenv.ts, secret.ts
  db/            kysely.ts, schema.ts, migrator.ts, transaction.ts (withTransaction), backup.ts
    migrations/  0001_initial_schema.ts (todas las tablas de [B-DB]), 0002_account_preferences.ts,
                 0003_signer_key_attestation.ts, grants.ts
    repositories/ outbox, idempotency
  audit/         audit-writer.ts (cadena HMAC, verificación)
  auth/          account-service.ts (reglas de cuenta), password.ts, common-passwords.ts, otp.ts, challenges.ts,
                 sessions.ts, csrf.ts, risk.ts (fuerza bruta y señales), totp.ts
  email/         provider.ts, mailgun.ts, smtp.ts, templates.ts (19 plantillas), format.ts, email-outbox.ts
  platform-session/ opaque.ts (registro y login OPAQUE), unlock.ts (desbloqueo → OPERATIONS), step-up.ts, token.ts
                 (JWS EdDSA), sessions.ts (filas y revocación), request-signature.ts (requests críticos y envelope de
                 envío), plugin.ts (Fastify), keys.ts (session keys P-256), auth-secret.ts (derivación del cliente)
  queue/         queues.ts, outbox-dispatcher.ts, outbox-consumer.ts, redis.ts
  chain/         rpc-quorum.ts, safe-tx.ts, eip712.ts, signatures.ts, create2.ts, decoders/, abis/ (generados)
  signer-client/ client.ts (mTLS hacia los shards, errores tipificados), sharding.ts (asignación por hash guardada en
                 signer_keys, S de onboarding y de rotación, reasignación tras una migración)
  gas/           gas-tank.ts (recargas de S, deploy de Safes y relay de cancelaciones por el shard `platform`)
  policy/        snapshot.ts (snapshot de policy firmado: firma, entorno y versión que se envía al signer)
  observability/ logger.ts, redaction.ts, metrics.ts
  api/           server.ts (dos listeners), errors.ts (RFC 9457), health.ts, routes/ (health, v1/auth, v1/users,
                 v1/sessions), plugins/ (auth y CSRF, rate limit, idempotencia, OpenAPI, seguridad)
  cli/           db.ts, audit-verify.ts, opaque-setup.ts, dev-session.ts, signer-reassign.ts
  services.ts    armado de los servicios de cuenta (proceso `api` y tests)
  main.ts        entrypoint `api` | `worker` | `gas-tank`
data/            lista vendorizada de passwords comunes (SecLists, SHA-256 fijado)
test/            unit, integración (Testcontainers + Anvil), API (inject), seguridad, email; vectors/ (copia de
                 contracts); `*.live.test.ts` contra Mailgun y la Gmail API
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
- **Cuenta [B-AUTH]**: las rutas sólo validan; las reglas viven en `AccountService`. Sin enumeración: registro,
  reenvío, olvido y desbloqueo responden igual exista o no la cuenta, y el login responde igual (con un Argon2id dummy)
  ante un email desconocido o una contraseña incorrecta; el estado de la cuenta sólo se revela a quien acierta la
  contraseña. Las transacciones que cuentan intentos se confirman antes de lanzar el error (el intento queda contado).
- **Sesiones y CSRF**: cookie `__Host-mtw_sid`/`__Host-mtr_sid` firmada (HttpOnly, Secure, SameSite=Strict, Path=/),
  en la base sólo `sha256(token)`, inactividad 30 min y absoluta 12 h, rotación en login, verificación, TOTP; la API
  nunca devuelve el token. Todo método no seguro exige Origin, JSON y `X-CSRF-Token = HMAC(CSRF_SECRET, sessionId)` o,
  sin sesión, atado a la cookie anónima `__Host-mtw_csrf`. Toda ruta declara `config.auth` y documenta 401/403/415.
- **Fuerza bruta [B-AUTH-08]** (`risk.ts`): contadores por cuenta y por IP en Valkey (ventana de 15 min), espera
  exponencial desde el 5.º fallo, bloqueo blando al 10.º (desbloqueo por OTP del email); señales de credential
  stuffing (`mtw_auth_risk_signals_total`, log y auditoría) por pico de fallos de la plataforma
  (`AUTH_FAILURE_SPIKE_PER_MINUTE`) o una IP contra muchas cuentas. La re-autenticación (desactivar TOTP) comparte el
  presupuesto.
- **Email [B-MAIL]**: el pedido se encola en la misma transacción con los parámetros sellados con
  `APP_FIELD_ENCRYPTION_KEY` (AAD = referencia); el worker descifra, renderiza y envía. `Message-ID =
<referencia@dominio>` (rastreo en el proveedor y en la casilla). La cola `email` reintenta 8 veces desde 5 s
  (≈ 10,5 min); un rechazo definitivo (SMTP 5xx, Mailgun 4xx) no se reintenta; un código ya vencido no se envía.
- **PlatformSession [B-PSES]**: segunda capa, sobre la sesión de cuenta. El desbloqueo de la Wallet es OPAQUE (RFC 9807)
  con la entrada hex(AuthSecret_U) que el navegador deriva de la Password U: el servidor nunca la ve. El estado del
  login vive 60 s en Valkey (un solo uso) y el cliente ata su session key P-256 con
  `HMAC(clave de sesión OPAQUE, thumbprint ‖ loginAttemptId)`. El step-up (email OTP + TOTP) da los scopes restringidos,
  cada uno en su listener, y rota la sesión de cuenta. El token es un JWS EdDSA (header y payload JCS, `kid` =
  thumbprint de la clave del emisor) con su fila en `platform_sessions`: revocar, cerrar sesión o restablecer la
  contraseña lo invalidan. Las rutas declaran `config.platformSession` (scopes y si son críticas); las críticas exigen
  `X-Session-Signature` sobre `MTW-REQ-V1` con timestamp ±60 s y nonce único (Valkey). Las fallas de esta capa son 403
  con código propio (la sesión de cuenta sigue vigente). Formatos con vectores en `contracts/test/vectors/wire`.

## Signer S y gas tank

El backend habla con los shards del signer (`backend/signer`, proyecto independiente) sólo por mTLS (`MTLS_CA_CERT_PATH`,
`MTLS_BACKEND_CLIENT_CERT_PATH`, `MTLS_BACKEND_CLIENT_KEY_PATH`; TLS 1.3). Cada wallet nueva va al shard que surge del
hash estable de su `walletId` sobre los shards activos de `SIGNER_SHARDS`, y esa asignación queda guardada en
`signer_keys` junto con la S y su `SignerKeyAttestation` (no se recalcula si cambian los shards) [B-SIG-09]. El signer
responde errores tipificados (`code`, `reason`, `retryable`) que el worker usa para reintentar o fallar ([B-Q-03]).

El proceso `gas-tank` usa la cuenta gas tank del shard `platform` (`SIGNER_PLATFORM_URL`) [B-SIG-05]: lleva cada S
bajo `GAS_TOPUP_MIN_WEI` a `GAS_TOPUP_TARGET_WEI` sin superar `GAS_TANK_DAILY_CAP_WEI` (el signer aplica además su propio
tope del snapshot), despliega Safes por la `WalletFactory` (sólo con una S atestada por un signer) y retransmite
cancelaciones de rotación firmadas por U o R. Cada tx queda en `chain_transactions` (y las recargas en `gas_topups`).

## PlatformSession en local (`dev:session`)

Sin frontend, `pnpm dev:session` hace lo mismo que el navegador contra la API local: la primera vez crea el usuario de
desarrollo atado a la Safe del seed local (`pnpm deploy-local && pnpm seed-local`), y en cada corrida inicia sesión,
desbloquea por OPAQUE si hace falta y firma un request (por defecto `POST /api/v1/platform-sessions/check` con `{}`).
Contraseñas, session key y headers quedan en `wallet/.secrets/` (0600, fuera de git); los headers se leen de
`wallet/.secrets/dev-session-headers.json` (con `--print` también se muestran). En Swagger: "Authorize" con
`platformSession`, `sessionSignature` y `csrfToken`, y los campos `X-Session-Timestamp` y `X-Session-Nonce` de la
operación; la firma vale 60 s y una sola vez. Con `APP_ENV` distinto de `local`, el comando se niega.

## Tests

`pnpm test` levanta PostgreSQL 18.6, Valkey 9.2 y Mailpit con las imágenes fijadas de `scripts/tools/versions.json` y el mismo
`infra/local/postgres/init-db.sh` del stack local; cada archivo clona su propia base desde una plantilla migrada. Los
tests de cadena levantan Anvil sobre el fork de Base (`BASE_RPC_URL` o `FORK_RPC_URL`; en local se lee de
`wallet/.env`) y el cliente de quórum se prueba con dos Anvil y un proxy de inyección de fallas. Cobertura: ≥ 90 % de
líneas en `src/chain/` (§10); `main.ts` y las CLIs se prueban como procesos reales. Los flujos de cuenta usan el
pipeline de email real (outbox → BullMQ → worker → SMTP de Mailpit) y leen los códigos de Mailpit. Los tests del
cliente del signer y del gas tank levantan shards reales del signer (procesos de `backend/signer`, que necesita sus
dependencias instaladas) y despliegan el sistema en el fork con los scripts del repo.

`pnpm test:live` envía por la API real de Mailgun (dominio sandbox) a `EMAIL_TEST_ADDRESS` y lee los códigos con la
Gmail API (credenciales `EMAIL_PROVIDER_*` y `EMAIL_TEST_*` del entorno o de `wallet/.env`). El sandbox firma DKIM y
SPF como `sandbox.mgsend.net` con un From `@sandbox….mailgun.org`: DMARC no alinea, Gmail lo manda a spam y rechaza
una parte (550 5.7.40); los tests reenvían sólo ante ese rechazo, acotado, y fallan ante cualquier otro. Con el dominio
propio de staging/producción (SPF y DKIM alineados) no ocurre. CI los corre cuando cambia email/autenticación, a
diario y a pedido (`docs/CI.md`).
