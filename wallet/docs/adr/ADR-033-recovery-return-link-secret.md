# ADR-033 — Secreto del pedido en el enlace de regreso de Recovery

- **Estado:** Aceptada
- **Fecha:** 2026-10-19
- **Fuentes:** planner §8.7 ([F-LNK-01], [F-LNK-02]), §8.1 ([F-KEY-07]), §7.11 (grupo `recovery` de [B-API]), §9.3 (ESC-20 en `docs/THREAT_MODEL.md`), P18.T01, P19.T03; segunda revisión independiente de P17.MAN (2026-10-19, hallazgos N2 y N10)

## Contexto

[F-LNK-02] confirma la dirección de R en la Wallet con el fragmento del enlace de regreso que arma la app Recovery
(`…/onboarding/confirm-recovery#eid=<id>&r=<R>`): la pestaña del onboarding comparaba `r` con la R que informa el
backend y, si coincidían, la daba por confirmada sin que el usuario tipeara nada. La segunda revisión de P17.MAN (N2)
mostró que eso no protege contra el adversario de ESC-20, el backend comprometido (ADV-03): conoce el `eid` del pedido y
la R′ que él mismo registró, así que puede armar ese enlace (y mandarlo por email, por ejemplo) y la Wallet confirmaría R′
sola. La comparación manual de la dirección completa sí lo detecta, porque el usuario copia la dirección de la pantalla de
Recovery, que no depende del backend; el enlace la salteaba. Además (N10), el aborto de un pedido que no se pudo
confirmar quedaba sólo en el navegador: el backend no registraba nada, así que una posible sustitución de R no dejaba
auditoría ni alerta.

## Decisión

El enlace de regreso sólo confirma R si trae un secreto que generó la Wallet para ese pedido y que el backend nunca ve;
todo pedido abortado se informa al backend.

- **Secreto `k`** ([F-LNK-01]): por cada pedido, la Wallet genera 16 bytes (128 bits) con `crypto.getRandomValues` y los
  pone, en base64url sin relleno (22 caracteres), sólo en el fragmento del enlace de ida y en su QR:
  `https://recovery…/enroll#eid=<enrollmentId>&n=<nonce>&k=<k>`. `k` nunca va a un servidor (ni a la API, ni a logs, ni a
  métricas): vive sólo en la memoria de la pestaña que hizo el pedido y se descarta con él. No se guarda en Web Storage:
  [F-KEY-07] y la regla Semgrep `mtw-fe-web-storage` lo limitan a dos módulos (flags no sensibles y el `state` de OAuth).
- **Recovery** ([F-LNK-02]): lee `k` del fragmento (que saca de la URL al leerlo, como `eid` y `n`), no lo usa ni lo
  manda a su backend y lo devuelve en el fragmento del enlace de regreso y de su QR:
  `https://wallet…/onboarding/confirm-recovery#eid=<id>&r=<R>&k=<k>`. Lo conserva en el viaje de ida y vuelta de OAuth
  de Drive (la ruta de regreso, en el sessionStorage de su origin). Un `k` mal formado invalida el enlace de ida; sin
  `k`, el pedido sigue y el regreso tampoco lo trae (la Wallet lo confirma a mano).
- **Pestaña del pedido**: la pestaña que abre el enlace de regreso le pasa `eid`, `r` y `k` por BroadcastChannel (mismo
  origin). La del pedido compara `k` en tiempo constante:
  - sin `k` o con otro: el enlace no lo armó la app Recovery del usuario → aborta el pedido sin consultar al backend y lo
    informa como `RETURN_LINK_UNVERIFIED`;
  - con el `k` del pedido y `r` distinta de la R que informa el backend: aborta y lo informa como
    `RETURN_LINK_KEY_MISMATCH`;
  - con el `k` del pedido y la misma R: R confirmada.
- **Pestaña sin el pedido**: si ninguna pestaña toma el enlace (la del pedido se cerró o está en otro dispositivo), la que
  lo abrió no puede comprobar `k` y no confirma nada: explica por qué y ofrece generar un pedido nuevo. Si el enlace no
  trae `k`, además cancela ese pedido y lo informa (`RETURN_LINK_UNVERIFIED`).
- **Comparación manual**: no cambia (los 10 grupos copiados de Recovery, sin que la Wallet muestre la R del backend, 3
  intentos); al agotarlos, o si el usuario deja el pedido después de una comparación que no coincidió, se informa como
  `MANUAL_COMPARISON_FAILED`.
- **Aborto informado** (N10): `POST /recovery/enrollments/{id}/reject` con `{reason}`, sólo en el listener de Wallet,
  con la PlatformSession del pedido (ONBOARDING, u OPERATIONS en el reemplazo de R; un pedido de otro usuario → 404) e
  idempotente. El pedido queda REJECTED con el motivo y el momento (`rejection_reason`, `rejected_at`; un pedido
  reemplazado por otro queda con `SUPERSEDED` y toma el motivo si el aviso llega después), la R que había enviado
  Recovery deja de estar viva, y quedan el evento de auditoría `RECOVERY_ENROLLMENT_REJECTED`, la notificación in-app
  `RECOVERY_ENROLLMENT_REJECTED`, el email de seguridad «Posible sustitución de tu clave R», el log de alerta
  `RECOVERY_KEY_SUBSTITUTION_SUSPECTED` y la métrica `mtw_recovery_enrollment_rejections_total{reason, purpose}`. Si la
  llamada falla, el aborto local sigue igual: ningún camino confirma ese pedido.

## Alternativas consideradas

- **Firmar el enlace de regreso con la Enrollment Key de Recovery y verificarla en la Wallet:** la Wallet obtendría la
  clave pública del backend, que un backend comprometido reemplaza; no agrega una fuente independiente.
- **Derivar el secreto del nonce del enrollment:** el nonce lo genera el backend, que entonces lo conoce.
- **Guardar `k` también en sessionStorage, para el enlace de regreso abierto en la misma pestaña:** exige sumar un módulo a
  la allowlist de Web Storage (ESLint y Semgrep, [F-KEY-07]) y cubre un caso raro: el enlace de ida abre Recovery en otra
  pestaña o en otro dispositivo, así que la pestaña del pedido casi nunca es la que abre el regreso. Si hiciera falta, se
  agrega un módulo `recovery-activation` con `k` acotado al pedido y su entrada en las dos allowlists.
- **Quitar la confirmación por enlace y dejar sólo la manual:** más fricción en el caso común (todo en un dispositivo)
  sin ganar seguridad frente al enlace con `k`.

## Consecuencias

- Un backend comprometido ya no confirma R′ con un enlace de regreso: sin `k` el enlace aborta el pedido y deja rastro.
  Para confirmar R′ necesitaría `k`, que sólo está en el navegador del usuario (memoria de la pestaña, fragmentos de los
  enlaces y la pantalla de Recovery), o que el usuario tipeara R′ en los 10 grupos.
- Riesgo residual: `k` viaja en el fragmento del enlace de ida, así que lo ve cualquier servicio por el que el usuario lo
  mande (la app recomienda el QR y lo dice); un atacante con ese `k` y control del backend podría armar el regreso con
  R′. Un XSS en el origin de Wallet o de Recovery queda fuera de este control (ya compromete U o R). Un backend
  comprometido puede ignorar el aviso del aborto: N10 es auditoría y alerta, no un control.
- Orden de despliegue: Recovery antes que Wallet. Una Recovery anterior no devuelve `k` y la Wallet nueva abortaría su
  enlace de regreso (falso positivo de sustitución); una Wallet anterior no manda `k` y la Recovery nueva arma el regreso
  sin `k`, que esa Wallet no exige.
- Un enlace de regreso abierto en una pestaña sin el pedido ya no confirma R: el usuario vuelve a la pestaña del pedido o
  genera otro, y Recovery crea otra R (la app lo avisa).
- La app Recovery muestra por qué se rechazó un pedido (`rejectionReason` en el estado del enrollment).

## Verificación

- Unit: `frontend/wallet/src/recovery-activation/activation.test.ts` (generación, formato y comparación de `k`, enlaces
  de ida y vuelta, motivos de aborto, aviso al backend) y `return-channel.test.ts`;
  `frontend/recovery/src/enroll/enrollment.test.ts` (lectura de `k`, regreso con el mismo `k`).
- Navegador sin stack: `frontend/wallet/test/browser/recovery-confirmation.spec.ts` (con el `k` del pedido confirma;
  sin `k`, con otro `k` o con otra R aborta e informa; en una pestaña sin el pedido no confirma) y
  `frontend/recovery/test/browser/enroll-backups.spec.ts` (el regreso lleva el mismo `k`; ningún pedido a la API lo
  lleva).
- Stack: `frontend/wallet/test/browser/stack/recovery-activation.spec.ts` (REJECTED con el motivo en el backend real),
  `frontend/recovery/test/browser/stack/enroll.spec.ts` y el recorrido `review/onboarding` (enlace de regreso desde la
  app Recovery real).
- Backend: `backend/app/test/recovery/enrollment-reject.test.ts` (sin la cadena: estado, R revocada, auditoría,
  notificación, email, alerta, métrica, idempotencia y [B-AUTHZ]), `test/recovery/enrollment.test.ts` (fork),
  `test/api/openapi-coverage.test.ts`, `test/email/templates.test.ts` y la migración 0009 en
  `test/integration/migrations.test.ts`.
