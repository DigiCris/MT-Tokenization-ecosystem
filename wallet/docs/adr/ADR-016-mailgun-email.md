# ADR-016 — Email transaccional con Mailgun

- **Estado:** Aceptada
- **Fecha:** 2026-10-16 · Actualizada: 2026-10-17 (instrucción del owner: Mailgun reemplaza al proveedor definido antes, y los códigos de la entrega real se leen con la Gmail API)
- **Fuentes:** planner §4 (ADR-016), §0.1 (R-14), §3.5 (Mailgun), §5.3, §7.12 ([B-MAIL-01], [B-MAIL-02], [B-MAIL-03]), §13 (entradas del 2026-10-17), §13.1 (H-01, H-03), P00 (PF-21, PF-31, PF-32); V9 §12, §13; prompt §23, §24

## Contexto

El prompt §23 pide elegir un proveedor real de email, indicar qué credenciales obtener y que los emails sensibles (en especial whitelist y cambios de seguridad) muestren con claridad acción, dirección, red y expiración. El prompt §24 exige documentar cada credencial. V9 §12 usa un canal externo que muestra el destino a whitelistear, y V9 §13 admite el email OTP como factor de 2FA y exige que, para el alta de destinos nuevos, el canal externo muestre explícitamente la dirección.

R-14 (2026-10-17) exige que toda funcionalidad se pruebe contra los servicios reales, incluidas la API de Mailgun y la entrega real de email a una casilla, sin nada opcional, simulado ni diferido.

Hechos verificados el 2026-10-17 (§3.5): la API de Mailgun es `https://api.mailgun.net` (región US; EU: `https://api.eu.mailgun.net`), con autenticación HTTP Basic `api:<API key>`, envío por `POST /v3/<dominio>/messages` y eventos por `GET /v3/<dominio>/events`; un dominio sandbox sólo entrega a destinatarios autorizados (máximo 5, cada uno acepta una invitación); un dominio propio se verifica con registros SPF y DKIM; el dominio sandbox del owner está en estado `active`.

Registro del 2026-10-17 (§13): el owner indicó usar Mailgun, con su cuenta, en reemplazo del proveedor definido antes; la lectura de los códigos de los tests pasó a la Gmail API (OAuth 2.0, `gmail.readonly`) en lugar de IMAP con contraseña de aplicación; una verificación real envió por Mailgun (sandbox) a `EMAIL_TEST_ADDRESS`, el correo llegó en 7 s y cayó en spam por tratarse del dominio sandbox compartido.

## Decisión

Email transaccional con **Mailgun** (cuenta del owner; dominio de envío propio por entorno verificado con SPF y DKIM; API HTTP con `fetch` nativo). En local y CI se usa **Mailpit** (SMTP real local) para los flujos deterministas, más tests obligatorios contra la API real de Mailgun con el dominio sandbox y de entrega real a una casilla autorizada (`EMAIL_TEST_*`), leyendo los códigos con la Gmail API (OAuth 2.0, scope `gmail.readonly`).

Detalle:

- **Proveedor** ([B-MAIL-01]): interfaz `EmailProvider` con adaptadores `mailgun` (staging/producción y tests reales; API HTTP con `fetch` nativo y autenticación Basic, sin SDK) y `smtp` (local/CI → Mailpit, puertos 1025 SMTP y 8025 UI/API, §5.3). El envío pasa por el outbox (`email_outbox` lógico en `outbox_events`) con reintentos (ADR-021).
- **Plantillas sensibles** ([B-MAIL-02]) para whitelist, rotaciones, recovery, step-up y reset: acción, dirección completa (checksum EIP-55, en grupos de 4), red ("Base mainnet — chainId 8453"; en local, "Base fork local — chainId 8453"), Safe, expiración (hora local del usuario y UTC), IP/dispositivo de origen y qué hacer si no fue el usuario. Nunca incluyen links que ejecuten acciones: el código se ingresa en la app.
- **Notificaciones** ([B-MAIL-03]): nuevo login, reset de password, whitelist solicitada/activada/removida, rotación propuesta/cancelada/ejecutada, recovery iniciado, operación de alto valor ejecutada y pausa de cooperación por integridad.
- **Tests reales:** el adaptador `mailgun` envía cada plantilla a `EMAIL_TEST_ADDRESS` y confirma el evento `delivered` en la Events API (P09.TST.g); la verificación de email, los OTP y el reset salen por Mailgun desde `no-reply@<EMAIL_PROVIDER_DOMAIN>` y el test lee cada código con la Gmail API (`users.messages.list` con una consulta que incluye un identificador único del envío e `includeSpamTrash=true`, y `users.messages.get`), sin mocks y sin tokens en logs (P09.TST.h).
- **Credenciales:** `EMAIL_PROVIDER_API_KEY`, `EMAIL_PROVIDER_DOMAIN` y `EMAIL_PROVIDER_BASE_URL` (dominio sandbox en local, provistas por el owner el 2026-10-17); para los tests, `EMAIL_TEST_ADDRESS`, `EMAIL_TEST_GOOGLE_CLIENT_ID`, `EMAIL_TEST_GOOGLE_CLIENT_SECRET` y `EMAIL_TEST_GOOGLE_REFRESH_TOKEN` (H-01). El preflight las valida sin mostrarlas (PF-21, PF-31, PF-32).
- **Separación por entorno:** staging y producción no comparten configuración de email (ADR-024); cada uno tiene su dominio de envío propio.

## Alternativas consideradas

- **El proveedor definido en la versión anterior del planner:** reemplazado por Mailgun por instrucción del owner, porque es el proveedor real ya contratado (§4, §13, 2026-10-17).
- **Lectura de los códigos de test por IMAP con contraseña de aplicación:** reemplazada por la Gmail API con OAuth 2.0 y scope `gmail.readonly` (§13, 2026-10-17).
- **Sólo Mailpit, sin proveedor real en los tests:** descartado por R-14; Mailpit queda para los flujos deterministas y los specs E2E que no son de entrega real.

## Consecuencias

- La entrega es verificable de punta a punta, con separación por entorno (§4).
- El dominio sandbox sólo admite hasta 5 destinatarios autorizados y, por ser compartido, sus correos suelen caer en spam: los tests buscan con `includeSpamTrash=true`. El go-live exige que los emails lleguen a la bandeja de entrada con el dominio propio y SPF, DKIM y DMARC (P30.T06).
- Los dominios de envío propios por entorno, verificados con SPF y DKIM, y el `ALERT_EMAIL` de producción se configuran en el despliegue final (H-03).
- Mailgun pasa a ser una dependencia operativa: hay playbook para la caída de Google o Mailgun (P26.T16), la API key entra en la rotación de claves (P26.T14) y las alertas de producción salen por el SMTP del dominio en Mailgun (P26.T12).
- Un compromiso del canal de email queda acotado por la activación diferida de 24 h de los destinos nuevos (ADR-006).

## Verificación

- P00.T08 — PF-21, PF-31 y PF-32: dominio de Mailgun `active`, Events API con la API key y Gmail API con `emailAddress == EMAIL_TEST_ADDRESS`, sin mostrar valores.
- P09.T07 — `EmailProvider` (Mailgun + SMTP/Mailpit) con outbox y reintentos; snapshots de plantillas con acción, dirección completa, red y expiración.
- P09.TST.g — adaptador `mailgun` contra la API real con el dominio sandbox y evento `delivered`.
- P09.TST.h — entrega real de punta a punta con lectura de códigos por la Gmail API.
- P09.MAN, P14.MAN y P15.MAN — revisión de los textos de email de cuenta, whitelist y rotaciones.
- P22.T06 — spec E2E `real-email.spec.ts` con entrega real.
- P24.T02 — alertas provocadas que llegan a Mailpit con el perfil `observability`.
- P26.T12, P26.T14 y P26.T16 — alertas por el SMTP de Mailgun, rotación de la API key y playbook de caída del proveedor.
- P30.T05 — smoke del ensayo de producción con email real.
- P30.T06 — `go-live.md` con la verificación de bandeja de entrada (no spam) con SPF, DKIM y DMARC.
- Trazabilidad: RQ-53, RQ-98.
