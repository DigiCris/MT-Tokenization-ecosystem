# ADR-033 — Secreto del pedido en el enlace de regreso de Recovery

- **Estado:** Aceptada
- **Fecha:** 2026-10-19
- **Fuentes:** planner §8.7 ([F-LNK-01], [F-LNK-02]), §8.1 ([F-KEY-07]), §7.11 (grupo `recovery` de [B-API]), §9.3 (ESC-20 en `docs/THREAT_MODEL.md`), P18.T01, P19.T03; segunda revisión independiente de P17.MAN (2026-10-19, hallazgos N2 y N10); revisión de seguridad independiente de la implementación de este ADR (2026-10-19, hallazgos ALTO 1, MEDIO 2, BAJO 3–8 y menores)

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
  métricas): en la Wallet vive sólo en la memoria de la pestaña que hizo el pedido y se descarta con él. No se guarda en
  Web Storage: [F-KEY-07] y la regla Semgrep `mtw-fe-web-storage` lo limitan a dos módulos (flags no sensibles y el
  `state` de OAuth).
- **Recovery** ([F-LNK-02]): lee `k` del fragmento (que saca de la URL al leerlo, como `eid` y `n`), no lo usa ni lo
  manda a su backend y lo devuelve en el fragmento del enlace de regreso y de su QR:
  `https://wallet…/onboarding/confirm-recovery#eid=<id>&r=<R>&k=<k>`. Un `k` mal formado invalida el enlace de ida; sin
  `k`, el pedido sigue y el regreso tampoco lo trae (la Wallet lo confirma a mano).
- **Excepción: el viaje de OAuth de Drive en Recovery.** El consentimiento de Google es una redirección de página
  completa, así que lo único que sobrevive es el estado del viaje en el sessionStorage de la pestaña
  (`src/drive/oauth-state.ts`, uno de los dos módulos con Web Storage permitido): en `/enroll`, su ruta de regreso lleva
  el pedido, también `k`. Es la única copia de `k` fuera de la memoria y de los fragmentos, y está acotada: se borra al
  volver por el callback (un solo uso), vence a los 10 minutos, y un viaje abandonado se descarta al arrancar la app
  fuera del callback, al volver la página del bfcache y al montar `/enroll`. Se decidió conservarla porque las
  alternativas son peores: un hash de `k` no sirve (el enlace de regreso lleva `k` en claro), no guardarlo dejaría sin
  enlace de regreso a todo pedido que conecta Drive (la Wallet aborta un regreso sin `k` como falsificado) y los otros
  caminos (`state` de OAuth, que va a Google; una ventana emergente) cambian [F-DRV-01] o mandan `k` a un servidor. La
  allowlist de ESLint (`STORAGE_ALLOWLIST`) y el exclude de Semgrep no cambian; la excepción queda documentada en el
  módulo y en sus comentarios.
- **Pestaña del pedido**: la pestaña que abre el enlace de regreso le pasa `eid`, `r` y `k` por BroadcastChannel (mismo
  origin). La del pedido compara `k` en tiempo constante:
  - sin `k` o con otro: el enlace no lo armó la app Recovery del usuario → aborta el pedido sin consultar al backend y lo
    informa como `RETURN_LINK_UNVERIFIED`;
  - con el `k` del pedido, el enlace es auténtico: sólo lo confirma que el backend informe ese mismo pedido SUBMITTED
    con exactamente esa R. Cualquier otra respuesta (otra R, otro pedido, ninguna R, otro estado o un error de la API)
    aborta el pedido y lo informa como `RETURN_LINK_KEY_MISMATCH`; sólo un error de red deja reintentar (volver a abrir
    el enlace o confirmar a mano);
  - con el `k` del pedido y la misma R: R confirmada.

  La pestaña del enlace muestra el resultado real que le responde la del pedido (comprobando, confirmado, cancelado o
  sin red), no un «Listo» genérico. Un pedido ya abortado, terminado o reemplazado no se confirma por ningún camino, ni
  con el `k` y la R correctos.
- **Ningún texto del backend en pantalla**: en este paso, y por regla en toda la app Wallet (`src/ui/errors.ts`), los
  errores se muestran con textos de la app elegidos por el código (o por el status si el código no está en su
  catálogo); el `title`, el `detail` y el `requestId` del backend nunca llegan a la pantalla, y los códigos que vienen en
  el detalle se traducen con tablas cerradas. Si no, un backend comprometido podría poner la R′ en grupos al lado de los
  campos de la comparación manual, o una instrucción junto a lo que se firma.
- **Pestaña sin el pedido**: si ninguna pestaña toma el enlace (la del pedido se cerró, se recargó o está en otro
  dispositivo), la que lo abrió no puede comprobar `k` y no confirma nada: lo explica enseguida, sin pasar por el
  onboarding (también en el reemplazo de R con la wallet ya activa), y ofrece seguir desde donde se genera un pedido
  nuevo. Si el enlace no trae `k`, además cancela ese pedido y lo informa (`RETURN_LINK_UNVERIFIED`) con una sesión del
  propósito del pedido, que lee del backend: ONBOARDING (con un step-up en la misma pantalla, o al seguir con la creación)
  u OPERATIONS (al desbloquear la wallet).
- **Comparación manual**: no cambia lo que se compara (los 10 grupos copiados de Recovery, sin que la Wallet muestre la
  R del backend, 3 intentos); antes de aceptarla, la Wallet vuelve a leer el pedido, y uno que el backend da por
  terminado (cancelado o reemplazado desde otra pestaña o dispositivo, vencido) se cierra con la opción de generar otro.
  Al agotar los intentos, o si el usuario deja el pedido después de una comparación que no coincidió (genera otro, sale
  de la pantalla, recarga o cierra la pestaña), se informa como `MANUAL_COMPARISON_FAILED`.
- **Aborto informado** (N10): `POST /recovery/enrollments/{id}/reject` con `{reason}`, sólo en el listener de Wallet,
  con una PlatformSession del propósito del pedido (ONBOARDING, u OPERATIONS en el reemplazo de R; un pedido de otro
  usuario → 404) e idempotente. El pedido queda REJECTED con el motivo y el momento (`rejection_reason`, `rejected_at`,
  y aparte `rejection_reported_at`: un pedido reemplazado por otro queda con `SUPERSEDED`, toma el motivo si el aviso
  llega después y conserva cuándo se lo reemplazó), la R que había enviado Recovery deja de estar viva, y quedan el
  evento de auditoría `RECOVERY_ENROLLMENT_REJECTED`, la notificación in-app `RECOVERY_ENROLLMENT_REJECTED`, el email de
  seguridad «Posible sustitución de tu clave R», el log de alerta `RECOVERY_KEY_SUBSTITUTION_SUSPECTED` y la métrica
  `mtw_recovery_enrollment_rejections_total{reason, purpose, alerted}`. Para que el aviso no se pierda en silencio, la
  Wallet lo guarda en una cola en memoria de la pestaña y lo reenvía con la próxima sesión válida de ese propósito (o con
  la misma, más tarde, si falló la red o la plataforma); al cerrar o recargar la pestaña después de una comparación que
  no coincidió, lo manda con `fetch` keepalive en `pagehide`, firmado de antemano (la firma es asíncrona y vale ±60 s,
  así que se vuelve a firmar cada 30 s). Si nada de eso llega, el aborto local sigue igual: ningún camino confirma ese
  pedido.
- **Reemplazo de R con la rotación en curso**: el rechazo de un pedido de reemplazo cuya rotación hacia R′ ya se preparó
  o se propuso (de AWAITING_SIGNATURE a EXECUTING, la que armó la plataforma con ese pedido o una on-chain hacia la misma
  dirección) no se acepta: responde 409 y deja la auditoría `RECOVERY_ENROLLMENT_REJECTION_REFUSED` con la alerta,
  porque la cadena la ejecutaría igual; lo que corresponde es cancelar la rotación con U o con la R actual. A la vez, la
  propuesta de la rotación vuelve a exigir el pedido SUBMITTED con esa R′ dentro de su transacción (con el mismo lock
  que el rechazo).
- **La cadena manda**: si de todos modos se ejecuta on-chain una rotación hacia una R′ cuyo pedido había quedado
  REJECTED (una fila anterior a esta revisión, una carrera), la sincronización la aplica igual: el pedido queda
  CONFIRMED sin el motivo del rechazo, la R′ vuelve a estar viva y sale la alerta `RECOVERY_REJECTED_KEY_EXECUTED`. Un
  evento del RotationTimelock que no se puede aplicar ya no frena la sincronización de todas las wallets: queda en
  cuarentena (`ROTATION_EVENT_QUARANTINED`, con reintentos espaciados y métricas) y los siguientes de su misma Safe
  esperan detrás de él.
- **Email del rechazo, uno por ventana**: el email de seguridad sale uno por usuario cada hora; los rechazos siguientes
  de la ventana conservan su aviso in-app, su auditoría, la alerta y la métrica, y su email sale en un resumen al cerrar
  la ventana. El aviso tardío de un pedido reemplazado hace más de 15 minutos (su vigencia) o rechazado antes de que
  existiera el motivo no avisa ni alerta: sólo auditoría y métrica (`alerted="false"`). Así nadie con la sesión del
  usuario convierte cada pedido en un email ni fatiga sus alertas.

## Alternativas consideradas

- **Firmar el enlace de regreso con la Enrollment Key de Recovery y verificarla en la Wallet:** la Wallet obtendría la
  clave pública del backend, que un backend comprometido reemplaza; no agrega una fuente independiente.
- **Derivar el secreto del nonce del enrollment:** el nonce lo genera el backend, que entonces lo conoce.
- **Guardar `k` también en sessionStorage de la Wallet, para el enlace de regreso abierto en la misma pestaña:** exige
  sumar un módulo a la allowlist de Web Storage (ESLint y Semgrep, [F-KEY-07]) y cubre un caso raro: el enlace de ida
  abre Recovery en otra pestaña o en otro dispositivo, así que la pestaña del pedido casi nunca es la que abre el
  regreso. Si hiciera falta, se agrega un módulo `recovery-activation` con `k` acotado al pedido y su entrada en las dos
  allowlists.
- **Guardar sólo un hash de `k` (o nada) durante el viaje de OAuth de Recovery:** ver la excepción de arriba.
- **Quitar la confirmación por enlace y dejar sólo la manual:** más fricción en el caso común (todo en un dispositivo)
  sin ganar seguridad frente al enlace con `k`.
- **Aceptar el rechazo de un reemplazo de R con la rotación en curso y que la sincronización lo ignore:** el pedido
  quedaría REJECTED con R′ como owner (o la sincronización se trabaría con el constraint, como pasaba): el 409 obliga a
  resolverlo donde se puede, cancelando la rotación.

## Consecuencias

- Un backend comprometido ya no confirma R′ con un enlace de regreso: sin `k` el enlace aborta el pedido y deja rastro.
  Para confirmar R′ necesitaría `k`, que sólo está en el navegador del usuario (memoria de la pestaña, fragmentos de los
  enlaces, la pantalla de Recovery y, durante el viaje de OAuth de Drive, el estado de ese viaje en Recovery), o que el
  usuario tipeara R′ en los 10 grupos; y con `k` no puede dejar el pedido vivo con una respuesta rara ni mostrar R′ en un
  error, porque nada de lo que responde aparece en pantalla.
- Riesgo residual: `k` viaja en el fragmento del enlace de ida, así que lo ve cualquier servicio por el que el usuario lo
  mande (la app recomienda el QR y lo dice); un atacante con ese `k` y control del backend podría armar el regreso con
  R′. Un XSS en el origin de Wallet o de Recovery queda fuera de este control (ya compromete U o R). Un backend
  comprometido puede ignorar el aviso del aborto: N10 es auditoría y alerta, no un control.
- Riesgo residual (bajo): el historial global del navegador, y su sincronización entre dispositivos si está activa,
  conserva las URLs de los enlaces de ida y de regreso con `#eid…&k=…`: `history.replaceState` limpia la barra y la
  entrada de la sesión, no ese historial. Sirve sólo mientras vive la pestaña del pedido de la Wallet (que tiene `k` en
  memoria) y además hace falta controlar el backend (RR-17 en el threat model).
- Riesgo residual (bajo): el aviso del aborto es de mejor esfuerzo. La cola vive en la memoria de la pestaña (se pierde
  si se cierra sin una sesión válida), y el aviso keepalive de `pagehide` no sale si la sesión ya venció o si el
  navegador no lo manda; el aborto local no depende de eso.
- Orden de despliegue: Recovery antes que Wallet. Una Recovery anterior no devuelve `k` y la Wallet nueva abortaría su
  enlace de regreso (falso positivo de sustitución); una Wallet anterior no manda `k` y la Recovery nueva arma el regreso
  sin `k`, que esa Wallet no exige. El backend (migración 0010) va antes que la Wallet nueva: el aviso de rechazo nuevo
  usa sus columnas.
- Un enlace de regreso abierto en una pestaña sin el pedido ya no confirma R: el usuario vuelve a la pestaña del pedido
  o genera otro, y Recovery crea otra R (la app lo avisa).
- La app Recovery muestra por qué se rechazó un pedido (`rejectionReason` en el estado del enrollment).
- El email «Posible sustitución de tu clave R» dice lo que pasa con la dirección del pedido cancelado sin afirmar que no
  quedó registrada en la Safe (en el reemplazo de R pide cancelar una rotación que no se esperaba).

## Verificación

- Unit: `frontend/wallet/src/recovery-activation/activation.test.ts` (generación, formato y comparación de `k`, enlaces
  de ida y vuelta, motivos de aborto, respuestas inconsistentes con `k` válido), `return-channel.test.ts` (resultado
  real hacia la pestaña del enlace, mensajes mal formados), `abort-reports.test.ts` (cola, reenvío con la próxima
  sesión, respuestas definitivas, keepalive en `pagehide`), `src/ui/errors.test.ts` (ningún texto del backend) y
  `src/api/client.test.ts` (request firmado de antemano); `frontend/recovery/src/enroll/enrollment.test.ts` (lectura de
  `k`, regreso con el mismo `k`) y `src/drive/oauth.test.ts` (viaje abandonado).
- Navegador sin stack: `frontend/wallet/test/browser/recovery-confirmation.spec.ts` (con el `k` del pedido confirma;
  sin `k`, con otro `k` o con otra R aborta e informa, y la pestaña del enlace lo dice; un enlace tardío con el `k` y la
  R correctos después de un aborto no confirma; con `k` válido y una respuesta inconsistente —sin R, otro pedido, un 409
  con una dirección en el texto— aborta y la dirección no aparece en el DOM; un enlace viejo o el de antes de recargar no
  confirman; un pedido cancelado o reemplazado desde otro lado se cierra; dejar el pedido tras una comparación fallida
  lo informa; en una pestaña sin el pedido lo explica enseguida, también en el reemplazo de R con la wallet activa; `k`
  no viaja en rutas, cuerpos ni headers, tampoco en los rechazos) y `frontend/recovery/test/browser/enroll-backups.spec.ts`
  y `enroll-drive-oauth.spec.ts` (el regreso lleva el mismo `k`, también después del viaje de OAuth de Drive; el estado
  del viaje se borra al volver y al abandonarlo; ningún pedido a la API lleva `k`).
- Stack: `frontend/wallet/test/browser/stack/recovery-activation.spec.ts` (REJECTED con el motivo en el backend real,
  también por el aviso keepalive al recargar), `replace-recovery.spec.ts` (confirmación por enlace en el reemplazo de R;
  con la rotación propuesta el rechazo da 409 y la ejecución on-chain deja el pedido CONFIRMED),
  `frontend/recovery/test/browser/stack/enroll.spec.ts` y el recorrido `review/onboarding` (enlace de regreso desde la
  app Recovery real).
- Backend: `backend/app/test/recovery/enrollment-reject.test.ts` (sin la cadena: estado, R revocada, auditoría,
  notificación, email y su resumen por ventana, alerta, métrica, idempotencia, [B-AUTHZ], reemplazo de R con OPERATIONS
  y ONBOARDING → 403, 409 con la rotación en curso y la ejecución aplicada igual, la propuesta frenada por un rechazo en
  el medio, avisos tardíos de reemplazados, pedido vencido, filas anteriores a 0009, el pedido vivo intacto y la Safe
  esperada descartada), `test/rotations/sync-quarantine.test.ts` (cuarentena por evento sin frenar a las demás Safes),
  `test/recovery/enrollment.test.ts` (fork), `test/api/openapi-coverage.test.ts`, `test/email/templates.test.ts` y las
  migraciones 0009 y 0010 en `test/integration/migrations.test.ts`.
