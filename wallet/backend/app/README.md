# Backend (`wallet/backend/app`)

API, worker, watcher, indexer y gas tank de MT Wallet: un solo proyecto pnpm con varios entrypoints (ADR-009, §7 del
planner). P08 deja las fundaciones: configuración validada, modelo de datos completo con migraciones, cola con outbox
transaccional, cliente RPC de quórum, logs con redacción, métricas, health, API con dos listeners, OpenAPI 3.1,
errores RFC 9457, idempotencia, rate limiting y audit log append-only con cadena HMAC. P09 agrega la cuenta
centralizada [B-AUTH] (registro y verificación de email, login, sesiones, CSRF, olvido y reset de contraseña, fuerza
bruta y señales de riesgo, TOTP) y el email transaccional [B-MAIL] (Mailgun o SMTP/Mailpit por el outbox). P10, la
PlatformSession [B-PSES]: desbloqueo de la Wallet por OPAQUE con AuthSecret_U, step-up con email OTP (+ TOTP), tokens
JWS EdDSA de 15 min atados a una session key P-256 y requests críticos firmados. P11–P12: cliente mTLS del signer,
gas tank y onboarding server-side de la wallet hasta ACTIVE. P13: pipeline de operaciones (máquina de estados, nonces,
worker S con lease y fencing, finalidad y reorgs, indexer y reconciliación) y la policy propia del backend.

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
pnpm dev:worker          # outbox, email y worker S (watcher, indexer, reconciliación), métricas :9465
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
                 0003_signer_key_attestation.ts, 0004_wallet_onboarding.ts, 0005_operation_pipeline.ts,
                 0006_whitelist_send_swap.ts, grants.ts
    repositories/ outbox, idempotency
  audit/         audit-writer.ts (cadena HMAC, verificación)
  auth/          account-service.ts (reglas de cuenta), password.ts, common-passwords.ts, otp.ts, challenges.ts,
                 sessions.ts, csrf.ts, risk.ts (fuerza bruta y señales), totp.ts
  email/         provider.ts, mailgun.ts, smtp.ts, templates.ts (20 plantillas), format.ts, email-outbox.ts
  platform-session/ opaque.ts (registro y login OPAQUE), unlock.ts (desbloqueo → OPERATIONS), step-up.ts, token.ts
                 (JWS EdDSA de PlatformSession y ChallengeCompletion), sessions.ts (filas y revocación),
                 request-signature.ts (requests críticos y envelope de
                 envío), plugin.ts (Fastify), keys.ts (session keys P-256), auth-secret.ts (derivación del cliente)
  queue/         queues.ts, outbox-dispatcher.ts, outbox-consumer.ts, redis.ts
  chain/         rpc-quorum.ts, safe-tx.ts, eip712.ts, signatures.ts, create2.ts, safe-proxy.ts (creation code del
                 proxy de Safe fijado), safe-state.ts (estado y deriva de configuración de una Safe), watcher.ts
                 (finalidad y reorgs), indexer.ts (eventos de SafeL2, Transfer y DestinationWhitelist),
                 reconciler.ts (DB ↔ cadena),
                 decoders/, abis/ (generados)
  signer-client/ client.ts (mTLS hacia los shards, errores tipificados), sharding.ts (asignación por hash guardada en
                 signer_keys, S de onboarding y de rotación, reasignación tras una migración)
  gas/           gas-tank.ts (recargas de S, deploy de Safes y relay de cancelaciones por el shard `platform`)
  policy/        snapshot.ts (snapshot de policy firmado completo), store.ts (anti-rollback en policy_snapshots),
                 evaluate.ts (policy del backend, contrastada con los vectores compartidos)
  operations/    state-machine.ts (transiciones auditadas), nonce-manager.ts, service.ts (prepare, par de swap, firmas,
                 cancelación por NoOp, lecturas, vencimientos), chain-context.ts, challenges.ts, ledger.ts (24 h),
                 intent.ts (intención canónica y vistas de la API), pairing.ts (approve/swap), groups.ts (estado
                 del grupo de un swap), two-factor.ts (2FA de alto valor), wallet-access.ts ([B-AUTHZ])
  whitelist/     validation.ts (destinos), service.ts (pedido, challenge, confirmación, baja, lectura), sync.ts
                 (eventos on-chain → altas, bajas y activación)
  send/          service.ts (prepare de transfer), notifications.ts (aviso de alto valor ejecutado)
  swap/          quote.ts (QuoterV2), prepare.ts (par approve/swap, re-cotización, revocación, grupo), coordinator.ts
                 (pares incompletos, estado del grupo, allowances residuales)
  notifications/ notify.ts (notificaciones in-app con deduplicación)
  worker/        main.ts (cola wallet-operations y lazos periódicos), pipeline.ts (12 pasos), lease.ts (lease por
                 Safe con fencing), fees.ts (EIP-1559 con topes y reemplazo), effects.ts (efectos de P14)
  wallets/       wallet-service.ts (onboarding: alta, U, asignación de S, Safe esperada, pedido de deploy),
                 deployer.ts (deploy y activación en el proceso gas-tank), verification.ts (V9 §16), salt.ts,
                 key-restore.ts (KEY_RESTORE), sovereign.ts (SOVEREIGN_MODIFIED), balances.ts, schemas.ts
  recovery/      enrollment.ts (enrollment de R y autorización de creación firmada por U)
  observability/ logger.ts, redaction.ts, metrics.ts
  api/           server.ts (dos listeners), errors.ts (RFC 9457), health.ts, routes/ (health, v1/auth, v1/users,
                 v1/sessions, v1/platform-sessions, v1/wallets, v1/recovery, v1/operations, v1/whitelist, v1/send,
                 v1/swap, v1/balances, v1/emergency), plugins/ (auth y CSRF, rate limit, idempotencia, OpenAPI,
                 seguridad)
  cli/           db.ts, audit-verify.ts, opaque-setup.ts, dev-session.ts, signer-reassign.ts
  services.ts    armado de los servicios de cuenta y de onboarding (proceso `api` y tests)
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

## Onboarding de la wallet (P12)

Todo por la API del listener de Wallet con la PlatformSession ONBOARDING (step-up), salvo lo que hace Recovery:

1. `POST /wallets` → CREATING (o la wallet en curso). `POST /wallets/{id}/user-key/opaque-registration` y
   `POST /wallets/{id}/user-key`: dirección de U, KDF público, backups confirmados (al menos uno que no dependa de la
   plataforma) y registro OPAQUE PENDING.
2. `POST /wallets/{id}/recovery/enrollments` (nonce de 32 bytes, 15 min). En Recovery, con la sesión ENROLLMENT:
   `POST /recovery/enrollments/{id}/enrollment-key` (P-256, una vez) y `.../submit` con `RecoveryEnrollment` firmado por
   la Enrollment Key y la prueba de control EIP-712 de R (EOA, distinta de U, nunca usada por otra wallet).
3. `POST /wallets/{id}/executor`: el shard asignado crea S con su `SignerKeyAttestation` y el backend fija la Safe
   esperada — cálculo local (initializer + CREATE2 con el creation code fijado y
   `saltNonce = uint256(keccak256(abi.encode("MTW_SALT_V1", platformId, walletId)))`) igual a
   `WalletFactory.predictWalletAddress` — y devuelve el typed data de `WalletCreationAuthorization`.
4. `POST /recovery/enrollments/{id}/incorporate`: la autorización firmada por U, aceptada sólo si cada campo coincide.
5. `POST /wallets/{id}/deploy` → DEPLOYING y evento `WALLET_DEPLOY_REQUESTED` (cola `gas-tank`). El proceso `gas-tank`
   llama `WalletFactory.createWallet(U, R, S, salt)` (o registra la Safe si un tercero ya la desplegó) → VERIFYING →
   verificación V9 §16 por quórum contra las direcciones y codehashes del snapshot firmado → ACTIVE (claves y registro
   OPAQUE ACTIVE, S fondeada) o FAILED con el ítem que falló. `GET /wallets/{id}/deployment` expone todo lo necesario
   para la verificación propia del frontend; la Safe operativa sólo aparece en `GET /wallets/me` con la wallet ACTIVE.

KEY_RESTORE (U restaurada desde las 17 palabras o rotación de `OPAQUE_SERVER_SETUP`): step-up con la prueba de posesión
(firma EIP-712 `KeyRestore` de la U vigente on-chain) → `POST /wallets/{id}/user-key/restore` reemplaza el registro
OPAQUE de esa misma U.

## Operaciones (P13)

Una operación es una SafeTx de la Safe con su intención canónica (`canonical_intent`, de donde se recalcula el
SafeTxHash). La prepara un flujo del backend (`OperationService.prepare`: policy con hechos on-chain por quórum,
pre-check del Guard y nonce asignado bajo el lock de la wallet), la firma U (o R) en el navegador y la ejecuta el
worker S con la co-firma del signer. Máquina de estados [B-SM] (`src/operations/state-machine.ts`): toda transición es
un `UPDATE … WHERE id AND status IN (…) [AND lease_version]` con su evento `OPERATION_<ESTADO>` (y su outbox) en la
misma transacción; la base rechaza al confirmar un cambio de estado sin ese evento (constraint trigger).

```text
CREATED ──firma U/R──▶ USER_SIGNED ──outbox──▶ QUEUED ──lease──▶ VALIDATING ──checks──▶ READY ──signer + tx──▶ SUBMITTED
CREATED ──15 min──▶ EXPIRED · CREATED ──cancelar──▶ CANCELLED
VALIDATING | READY | SUBMITTED ──transitorio──▶ FAILED_RETRYABLE ──backoff──▶ QUEUED   (20 reintentos → FAILED_FINAL)
VALIDATING | READY | SUBMITTED ──definitivo──▶ FAILED_FINAL
QUEUED ──NoOp que perdió la carrera / firma de más de 24 h──▶ FAILED_FINAL                         (agregado a §7.4)
SUBMITTED ──receipt ok──▶ MINED ──bloque safe──▶ CONFIRMED ──bloque finalized──▶ FINALIZED
MINED | CONFIRMED ──reorg──▶ REORGED ──▶ QUEUED (la misma SafeTx otra vez) | MINED (la misma tx re-incluida, agregado)
USER_SIGNED | QUEUED | READY | SUBMITTED | FAILED_RETRYABLE | FAILED_FINAL ──cancelar──▶ CANCEL_REQUESTED
CANCEL_REQUESTED ──se mina la NoOp──▶ CANCELLED · CANCEL_REQUESTED ──se mina la original──▶ MINED
```

- **API**: `POST /operations/{id}/signatures` (crítico, idempotente; en Wallet firma U con OPERATIONS y en Recovery R
  con RECOVERY): firma ECDSA estricta contra el rol vigente on-chain, envelope `MTW-SUBMIT-V1` firmado por la session
  key (±60 s, dentro de la vigencia de la sesión), SafeTxHash recalculado, policy y 2FA → USER_SIGNED → QUEUED +
  `OPERATION_QUEUED`. `POST /operations/{id}/cancel`: sin firma → CANCELLED (el nonce vuelve a estar disponible);
  firmada → CANCEL_REQUESTED y la NoOp del mismo nonce a firmar. `GET /operations/{id}` y
  `GET /wallets/{id}/operations` con el historial (de la auditoría).
- **Nonces** [B-NONCE-01/02]: el menor nonce ≥ el on-chain que no use ninguna operación viva; una CREATED vencida o
  cancelada (o una FAILED_FINAL) libera el suyo y la próxima lo ocupa. Una sola SafeTx viva por hash.
- **Worker S** (`src/worker/pipeline.ts`): por Safe con lease de 30 s y fencing (`exec_lease_version` copiado en
  `lease_version`), en orden estricto de nonce (las de nonce mayor quedan `WAITING_LOWER_NONCE`) y en paralelo entre
  Safes (`WORKER_OPERATIONS_CONCURRENCY`, ADR-019). Pasos: sesión y envelope al momento del envío (firma de menos de
  24 h) → SafeTxHash → firma estricta contra el rol → nonce → policy (ledger de 24 h, challenges) y whitelist →
  configuración de la Safe intacta (si no, SOVEREIGN_MODIFIED) → `evaluateAssisted` + `eth_call` desde la Safe →
  firma de S en el signer (que repite todo y simula) → tx registrada antes de transmitirse (write-ahead) → receipt con
  reemplazo por fee bump (≥ 12,5 %, mismo nonce de cuenta, topes del snapshot) → MINED. Un revert minado se re-simula:
  determinístico → FAILED_FINAL + alerta; transitorio → reintento. Si el nonce de S avanzó sin receipt de nuestras tx
  → TX_DROPPED y reintento. Otro worker retoma VALIDATING/READY/SUBMITTED con el lease vencido; una SUBMITTED se
  reconcilia por sus `chain_transactions` antes de retransmitir.
- **Watcher** (`WATCHER_INTERVAL_MS`): con `CONFIRMATION_POLICY=tags` CONFIRMED = bloque ≤ head `safe` y FINALIZED =
  bloque ≤ head `finalized` (mínimo entre proveedores, hash reconfirmado); con `depth`, por profundidad. Reorg →
  REORGED (`REORG_DETECTED`) y se resuelve solo. Una inconsistencia entre RPCs no transiciona nada.
- **Indexer** (`INDEXER_INTERVAL_MS`): eventos de SafeL2 (`safe_executions`: las ejecuciones de la plataforma ligadas
  a su operación y las soberanas, auditadas) y `Transfer` de USDC/USDT (`token_transfers`), con cursor por hash de
  bloque (reorg → retrocede y re-escanea) y la misma finalidad. Si el proveedor limita el rango de `eth_getLogs`, el
  rango se achica solo.
- **Reconciliación** (`RECONCILER_INTERVAL_MS`; completa una vez por día): configuración de la Safe, nonce, ejecuciones
  indexadas, roles, whitelist, rotaciones pendientes y saldos contra el neto indexado; cada discrepancia se audita una
  vez (`RECONCILIATION_DISCREPANCY`) y alerta.
- **SOVEREIGN_MODIFIED** (P13.T11): si U+R cambiaron la configuración de la Safe (Guard, module guard, fallback,
  módulos, threshold, owners ≠ roles, singleton), la plataforma no co-firma: wallet marcada con los ítems, auditoría,
  notificación y email al usuario, y el signer también se niega por su cuenta.

Alertas en logs (campo `alert`): `REORG_DETECTED`, `TX_REVERTED`, `TX_STUCK`, `FEE_CAP`, `RETRIES_EXHAUSTED`,
`SAFE_CONFIG_MODIFIED`, `RECONCILIATION_DISCREPANCY`, `SIGNER_RESPONSE_MISMATCH`. Métricas: `mtw_operation_transitions_total`,
`mtw_wallet_operations{status}`, `mtw_wallet_operations_stuck`, `mtw_worker_step_duration_seconds`,
`mtw_executor_transactions_total`, `mtw_reorgs_detected_total`, `mtw_reconciler_discrepancies_total`,
`mtw_indexer_head_block`. Cada proceso registra al arrancar el snapshot de policy que cargó (anti-rollback,
`policy_snapshots`).

## Whitelist, send y swap (P14)

- **Whitelist** (`src/whitelist/`): `POST /wallets/{id}/whitelist/requests` valida el destino (EIP-55 o minúsculas;
  ≠ dirección cero, la propia Safe, los contratos del sistema y de Safe y los tokens), rechaza duplicados y crea el
  challenge `WHITELIST_ADD` ligado a {userId, Safe, chainId, destino, acción, nonce, vencimiento} (15 min, 5 intentos,
  un solo uso): el email muestra la acción, la dirección completa en grupos de 4, la red, la Safe y la expiración. Un
  pedido nuevo del mismo destino reemplaza al que esperaba el código. `POST /whitelist/requests/{id}/confirm` verifica
  el código y devuelve la SafeTx `addDestination` para firmar con U, con la atestación `ChallengeCompletion` (JWS del
  emisor de sesiones, ligada a la SafeTx exacta) guardada en la operación: el signer la exige antes de co-firmar. La
  sincronización del worker aplica los eventos confirmados de `DestinationWhitelist` (también las altas U+R por fuera,
  que quedan `SOVEREIGN`): ACTIVATING con el `activatesAt` del evento y ACTIVE cuando `isWhitelisted` es true on-chain
  (24 h, reloj de la cadena), con email y notificación. Baja: `POST /wallets/{id}/whitelist/{destination}/remove` (U)
  o `POST /wallets/{id}/emergency/whitelist-remove` (R, listener de Recovery), inmediata on-chain, con email.
- **Send** (`POST /wallets/{id}/send/prepare`): la SafeTx `transfer` de USDC o USDT se arma en el backend; la policy
  exige el destino activo on-chain (quórum), el saldo, los límites (por operación y 24 h) y el mínimo. Con monto ≥ el
  umbral la operación vuelve `requiresTwoFactor`: `POST /operations/{id}/two-factor` sin código crea el challenge
  `HIGH_VALUE_TX` (TOTP si está activo; si no, OTP por email con monto, token, destino y nonce) y con código lo
  verifica y guarda la `ChallengeCompletion`; recién entonces se acepta la firma de U. Al confirmarse se avisa
  (notificación + email `high-value-executed`, una sola vez).
- **Swap** (`src/swap/`): `GET /wallets/{id}/swap/quote` cotiza con QuoterV2 (`eth_call`, quórum, codehash fijado)
  sobre el pool canónico del SwapExecutor: `expectedOut`, `minOut` = expectedOut · (1 − slippage ≤ 50 bps) acotado al
  piso on-chain (amountIn · 0,995), impacto de precio contra el precio medio del pool y `deadline` = bloque + 10 min;
  si el pool se desvía de 1:1 más de 50 bps, `SWAP_PRICE_OUT_OF_RANGE`. `POST /wallets/{id}/swap/prepare` crea el
  grupo y el par `approve(SwapExecutor, amountIn)` exacto (nonce N) + `swap` (N+1); la firma de U de una mitad no
  encola nada hasta que llega la otra, y el worker y el signer exigen la pareja real ([B-SIG-02]). Un par sin encolar
  cuya otra mitad vence o se cancela se descarta (la mitad firmada queda FAILED_FINAL `PAIR_INCOMPLETE`, nonce
  liberado). Si el swap falla en forma definitiva con el approve ejecutado, el grupo queda FAILED con
  `nextActions: [REQUOTE, REVOKE_APPROVAL]`, la allowance residual se notifica una vez y se puede
  `POST /operation-groups/{id}/requote` (par nuevo en los nonces siguientes) o `POST /operation-groups/{id}/revoke-approval`
  (`approve(SwapExecutor, 0)`; con R, `POST /wallets/{id}/emergency/revoke-approval`). `GET /operation-groups/{id}`
  muestra el grupo con sus operaciones.
- **Lecturas**: `GET /wallets/{id}/balances` (USDC/USDT y allowance hacia el SwapExecutor, quórum),
  `GET /wallets/{id}/whitelist` (ambos listeners) y `GET /operation-groups/{id}`; todo recurso de otro usuario es 404.
- **Efectos** (`EFFECTS_INTERVAL_MS`, worker): sincronización de whitelist, coordinación de grupos de swap y avisos
  de alto valor, idempotentes y separados del pipeline.

Métricas: `mtw_whitelist_events_total{event}`, `mtw_two_factor_challenges_total{method,result}`,
`mtw_swap_quotes_total{result}`, `mtw_notifications_created_total{type}`.

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
pipeline de email real (outbox → BullMQ → worker → SMTP de Mailpit) y leen los códigos de Mailpit. El global setup
despliega el sistema una vez en el fork con los scripts del repo y vuelca el estado: los tests que lo usan levantan su
propio Anvil con `--load-state`. Los tests del cliente del signer, del gas tank y del onboarding levantan shards reales
del signer (procesos de `backend/signer`, que necesita sus dependencias instaladas); el onboarding se prueba de punta a
punta por la API (OPAQUE, firmas EIP-712 y P-256 reales) hasta ACTIVE, incluido el proceso `gas-tank` real.

`pnpm test:live` envía por la API real de Mailgun (dominio sandbox) a `EMAIL_TEST_ADDRESS` y lee los códigos con la
Gmail API (credenciales `EMAIL_PROVIDER_*` y `EMAIL_TEST_*` del entorno o de `wallet/.env`). El sandbox firma DKIM y
SPF como `sandbox.mgsend.net` con un From `@sandbox….mailgun.org`: DMARC no alinea, Gmail lo manda a spam y rechaza
una parte (550 5.7.40); los tests reenvían sólo ante ese rechazo, acotado, y fallan ante cualquier otro. Con el dominio
propio de staging/producción (SPF y DKIM alineados) no ocurre. CI los corre cuando cambia email/autenticación, a
diario y a pedido (`docs/CI.md`).
