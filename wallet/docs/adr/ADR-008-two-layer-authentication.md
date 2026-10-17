# ADR-008 — Autenticación en dos capas: cuenta y PlatformSession

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-008), §2.2, §3.5 (OPAQUE, Argon2id server), §7.1 ([B-AUTH-01] a [B-AUTH-09]), §7.2 ([B-PSES-01] a [B-PSES-06]), §7.11 ([B-RL]), §7.15 ([W-07]), §8.3 ([F-SES-01] a [F-SES-04]), §9.3; V9 §3, §8; prompt §7, §22; CF-02

## Contexto

V9 §3 separa la identidad centralizada de la custodia criptográfica: la cuenta puede recuperarse sin recuperar la U anterior. La cadena de autenticación de U es `Password U → Argon2id → Root_U → HKDF-SHA256("U-auth-v1") → AuthSecret_U → OPAQUE/PAKE → PlatformSession`, de modo que el servidor autentica el conocimiento del secreto sin recibir la Password U. La `PlatformSession {userId, safe, platformId, sessionPublicKey, sessionId, issuedAt, expiresAt}` dura 15 minutos y las requests críticas se autentican además con una session key efímera. Si el usuario pierde la Password U, recupera su cuenta por email, OTP, 2FA o verificación reforzada, crea una U nueva y usa R para reemplazar la anterior. V9 §8 agrega que las firmas recibidas fuera de una PlatformSession válida se ignoran aunque sean criptográficamente válidas.

El prompt §7 pide una cuenta centralizada completa (registro, login, logout, forgot y reset de password, gestión, expiración y revocación de sesiones) independiente de U y R: la password de login y la Password U no deben confundirse y un reset de la password centralizada no descifra la U anterior. El prompt §22 exige autenticación production-grade.

Conflicto CF-02: V9 modela la autenticación a partir de AuthSecret_U, mientras el prompt pide una cuenta con login y reset independientes de U/R.

Hechos verificados (§3.5): OPAQUE es RFC 9807 (jul-2025); `@serenity-kit/opaque` 1.1.0 lo implementa (opaque-ke 4.0.0, WASM, Node y browser, `keyStretching` configurable, pentest de 7ASecurity); `@cloudflare/opaque-ts` 0.7.5 está en draft-07 y sin mantenimiento; `@node-rs/argon2` 2.2.2 para hashing server-side.

## Decisión

Autenticación en dos capas: **cuenta** (email + password de login, Argon2id + pepper, cookies `__Host-`) y **PlatformSession** de 15 min (OPAQUE RFC 9807 con AuthSecret_U, o step-up con email OTP + TOTP) ligada a una session key P-256 no exportable que firma los requests críticos.

Capa 1 — cuenta ([B-AUTH]):

- **Registro** ([B-AUTH-01]): email normalizado (NFKC + lowercase, único por `platform_id`); password de login de 12 a 128 caracteres, rechazada si figura entre las 100.000 más comunes de SecLists (vendorizadas con commit y SHA-256 fijados, sin llamadas externas). Hash Argon2id (`@node-rs/argon2`) con m=64 MiB, t=3, p=1 sobre `HMAC-SHA256(PASSWORD_PEPPER_vN, password)`, guardando `pepper_version`.
- **Verificación de email** obligatoria antes de cualquier operación de wallet: OTP de 8 dígitos, TTL 15 min, 5 intentos, single-use ([B-AUTH-02]).
- **Login** con respuesta idéntica y tiempo aproximadamente constante para usuarios inexistentes; rotación de sesión al éxito ([B-AUTH-03]).
- **Sesiones** ([B-AUTH-04]): id aleatorio de 256 bits en la cookie `__Host-mtw_sid` (listener Wallet) o `__Host-mtr_sid` (listener Recovery), con `HttpOnly; Secure; SameSite=Strict; Path=/`; en la base sólo `sha256(id)`; idle timeout de 30 min y absoluto de 12 h; rotación en login, step-up y cambio de privilegios; listado y revocación individual o total.
- **CSRF** ([B-AUTH-05]): además de SameSite=Strict, todo método no-GET exige `X-CSRF-Token = base64url(HMAC-SHA256(CSRF_SECRET, sessionId))`, `Origin` exacto del listener y `Content-Type: application/json`.
- **Logout** revoca la sesión y todas sus PlatformSessions hijas ([B-AUTH-06]).
- **Forgot/reset** ([B-AUTH-07]): token de 256 bits por email (en el fragmento del link), TTL 30 min, single-use e invalidado por un pedido nuevo; el reset revoca todas las sesiones y PlatformSessions y notifica por email, y **no toca** `U.enc`, los registros OPAQUE ni nada de U o R.
- **Fuerza bruta** ([B-AUTH-08]): contadores por cuenta y por IP; tras 5 fallos en 15 min, espera exponencial; tras 10, bloqueo blando con desbloqueo por email OTP.
- **TOTP** RFC 6238 opcional ([B-AUTH-09]): secreto de 160 bits cifrado con `APP_FIELD_ENCRYPTION_KEY` (AES-256-GCM, AAD = userId), anti-replay por `last_used_step`, 10 códigos de recuperación; si está activo es obligatorio en login y step-up.

Capa 2 — PlatformSession ([B-PSES]):

- **Estructura** ([B-PSES-01]): la de V9 extendida con `scope`, `authMethod` y `accountSessionId`; `scope ∈ {OPERATIONS, ONBOARDING, RECOVERY, U_REPLACEMENT, ENROLLMENT, KEY_RESTORE}`; `authMethod ∈ {OPAQUE_U, STEP_UP}`; 15 min, no renovable. `OPERATIONS` sólo se obtiene por OPAQUE con un registro ACTIVE (wallet ACTIVE).
- **OPAQUE** ([B-PSES-02]): RFC 9807 con `@serenity-kit/opaque`; la entrada es `hex(AuthSecret_U)`, ya estirado con Argon2id en el cliente, por lo que el `keyStretching` se fija en `{"argon2id-custom": {memory: 16384, iterations: 1, parallelism: 1}}` (KiB), idéntico en registro y login y versionado en `opaque_records`. `OPAQUE_SERVER_SETUP` es un secreto de larga vida. El cliente vincula su `sessionPublicKey` enviando `HMAC(opaqueSessionKey, sessionPublicKeyJwkThumbprint ‖ loginAttemptId)` en el mensaje final.
- **Step-up** sin U ([B-PSES-03]): cuenta autenticada + email OTP (+ TOTP si está activo) → scopes restringidos (ONBOARDING, RECOVERY, U_REPLACEMENT, ENROLLMENT); nunca `OPERATIONS`. `KEY_RESTORE` exige además prueba de posesión con la firma EIP-712 `KeyRestore` de la U restaurada, que debe coincidir con el rol U vigente on-chain.
- **Token** ([B-PSES-04]): JWS compacto EdDSA (Ed25519, librería `jose`) firmado con `SESSION_ISSUER_PRIVATE_KEY`, audiencias `mtw-api` y `mtw-signer`, enviado en el header `X-Platform-Session` (no en cookie).
- **Requests críticos** ([B-PSES-05]): header `X-Session-Signature` = ECDSA P-256 sobre `MTW-REQ-V1\n{method}\n{path}\n{sha256(body)}\n{timestamp}\n{requestNonce}\n{sessionId}`, timestamp ±60 s, `requestNonce` único (Valkey `SET NX`, TTL 5 min). La session key se genera con WebCrypto `extractable=false` y vive sólo en memoria.
- **Envelope de envío** ([B-PSES-06]): al enviar una firma U/R el cliente firma `MTW-SUBMIT-V1 {operationId, safeTxHash, sessionId, submittedAt}`; la validez se evalúa al momento del envío y la ejecución puede ocurrir después mientras no pasen 24 h desde `submittedAt` (después, `FAILED_FINAL` con `SIGNATURE_STALE`).
- **Matriz scope → operaciones** ([W-07]), aplicada igual por backend y signer.

## Alternativas consideradas

- **Una sola capa basada en OPAQUE (lectura literal de V9 §3):** no cubre la cuenta con login, forgot y reset independientes de U/R que pide el prompt §7, ni los flujos de recovery en los que U no está disponible (CF-02).
- **Reutilizar la password de login como Password U, o derivar una de la otra:** descartado; el prompt §7 exige que no se confundan y que el reset de la cuenta no descifre U.
- **`@cloudflare/opaque-ts` 0.7.5:** descartada por estar en draft-07 y sin mantenimiento (§3.5).
- **Guardar tokens de sesión en `localStorage` o `sessionStorage`:** descartado (prompt §22); los tokens viven sólo en memoria y las cookies de cuenta son HttpOnly.

## Consecuencias

- El reset de la password de login nunca toca `U.enc` ni el registro OPAQUE, y el servidor nunca recibe la Password U ni AuthSecret_U.
- Las operaciones críticas quedan ligadas a una session key no exportable y protegidas contra replay (timestamp + nonce único).
- OPAQUE corre en WASM: la CSP del Wallet necesita `'wasm-unsafe-eval'` ([F-SEC-01], ADR-023).
- Se suma complejidad: dos capas, step-up, seis scopes y una matriz que backend y signer deben aplicar igual.
- Límite conocido (§9.3): contra un backend comprometido, la verificación de PlatformSession y de challenges en el signer no agrega independencia, porque son claves del mismo dominio; la protección descansa en las firmas de U/R, en los checks propios del signer y en el Guard.
- Rotar `OPAQUE_SERVER_SETUP` obliga a re-registrar OPAQUE mediante `KEY_RESTORE` (P26.T14).
- Rate limits específicos para login, forgot-password, OTP y step-up ([B-RL]).

## Verificación

- P09.T01 a P09.T06 — registro y verificación de email, sesiones, CSRF, forgot/reset (incluye "reset no toca OPAQUE ni metadatos de claves"), fuerza bruta y TOTP.
- P09.TST.a a P09.TST.f — enumeración, sesiones expiradas o revocadas, CSRF, OTP expirado o reusado, lockout y atributos de cookies.
- P09.SEC — hashes con pepper, tiempos uniformes y ningún token de sesión en el body.
- P10.T01 a P10.T07 — `OPAQUE_SERVER_SETUP`, registro y login OPAQUE, step-up, token EdDSA, firma de requests y `dev:session` sólo en local.
- P10.TST y P10.SEC — OPAQUE ida y vuelta, scopes, replay y que el servidor nunca recibe Password U ni AuthSecret_U.
- P11.T03 — el signer verifica por su cuenta token, envelope y antigüedad ≤ 24 h.
- P13.TST.i — sesión expirada al enviar firma; ejecución legítima > 15 min (OK) y > 24 h (`SIGNATURE_STALE`).
- P17.T03, P17.T06 y P19.T01 — pantallas de cuenta, desbloqueo de Wallet y step-up de Recovery.
- P22.T02.a a P22.T02.d y P22.T03 — E2E de cuenta y ausencia de tokens en storages del navegador.
- P24.T04 — matriz de rate limits y escenarios de abuso.
- Trazabilidad: RQ-25, RQ-26, RQ-52, RQ-78, RQ-82.
