# ADR-012 — Backup en Google Drive appDataFolder sin JS de Google

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-012), §0.1 (R-14), §2.2, §3.5 (Google OAuth browser-only), §8.1 ([F-KEY-06], [F-KEY-10]), §8.2 ([F-DRV-01] a [F-DRV-05]), §8.5 ([F-SEC-01], [F-SEC-03]); V9 §4, §5, §17; prompt §8, §24; CF-03

## Contexto

V9 §4 define como storage por defecto de U el Google Drive `appDataFolder` exclusivo de Wallet, con `U.enc` ya cifrada localmente, y como alternativas el backup cifrado descargable, QR, export manual o custodia propia; el onboarding exige al menos una forma persistente de recuperar U. V9 §5 hace lo mismo con R en un `appDataFolder` exclusivo de Recovery, y V9 §17 exige OAuth y `appDataFolder` separados entre Wallet y Recovery. El prompt §8 pide que la integración con Drive sea directa desde el frontend y que no convierta al backend en custodio de U; el prompt §24 sugiere una variable `GOOGLE_CLIENT_SECRET_WALLET`.

Hechos verificados (§3.5): el flujo implícito (`response_type=token`) sigue documentado pero marcado como inseguro o "legacy"; el modelo de tokens de Google Identity Services exige cargar su JavaScript (popup); la documentación de "web server" marca `client_secret` como opcional, pero no está confirmado que authorization code + PKCE funcione sin backend; el scope `drive.appdata` es no sensible; el `appDataFolder` se borra si el usuario desinstala la app o lo elimina a mano.

Conflicto CF-03: un client secret no puede protegerse en un navegador y, además, metería al backend en el flujo de U.

## Decisión

Drive `appDataFolder` 100 % frontend, **sin JS de Google** en los origins criptográficos, como backup **adicional**: U y R exigen además un backup independiente de la plataforma ([F-KEY-06]). La conexión OAuth se hace antes de generar o desbloquear claves, porque la redirección recarga la app.

**Regla de decisión** (spike P17.T02): si el endpoint de token de Google acepta **authorization code + PKCE sin client secret** desde el navegador (CORS) para clientes "Web application", se usa ese flujo; si no, se usa el **flujo implícito por redirección de página completa** (token sólo en memoria, fragmento limpiado inmediatamente, `Referrer-Policy: no-referrer`). Proyecto de Google Cloud y cliente OAuth separados por app y por entorno. `GOOGLE_CLIENT_SECRET_*` no se usa.

Detalle ([F-DRV]):

- **OAuth** ([F-DRV-01]): redirección de página completa a `https://accounts.google.com/o/oauth2/v2/auth` con el `client_id` del proyecto de esa app, `scope=https://www.googleapis.com/auth/drive.appdata`, `state` aleatorio (en `sessionStorage` sólo durante el viaje de ida y vuelta) y `prompt=consent` en el primer uso. Con code + PKCE (S256) el código se canjea desde el navegador contra `https://oauth2.googleapis.com/token`. En ambos flujos: ningún JS de Google, token sólo en memoria, fragmento o query limpiados con `history.replaceState` antes de renderizar, sin refresh tokens persistidos y revocación al cerrar sesión (`POST https://oauth2.googleapis.com/revoke`).
- **Orden en onboarding:** conectar Drive → volver → generar U → cifrar → subir → verificar. A través de la redirección sólo sobreviven `state` y el verificador PKCE en `sessionStorage`, nunca claves ni sobres en claro.
- **API** ([F-DRV-02]): REST Drive v3 con `fetch` (listar, crear multipart en `parents:["appDataFolder"]`, actualizar y leer con `alt=media`); después de subir se vuelve a descargar y se verifica byte a byte.
- **Separación** ([F-DRV-03]): proyectos de Google Cloud y clientes OAuth separados por app y entorno (Wallet-local/staging/prod, Recovery-local/staging/prod), y por lo tanto `appDataFolder` separados; test empírico obligatorio de que un token del cliente Wallet no ve archivos del `appDataFolder` de Recovery y viceversa.
- **Backend fuera del flujo** ([F-DRV-04]): nunca recibe tokens de Drive ni el contenido de `U.enc` o `R.enc`.
- **Salud del backup** ([F-DRV-05]): chequeo periódico (cada 7 días o a pedido, sin bloquear nunca el desbloqueo) que reconecta Drive, verifica que el backup siga presente y coincida (hash) y, si falta, muestra una alerta persistente para re-subirlo.
- **CSP:** `connect-src` incluye `https://www.googleapis.com` y `https://oauth2.googleapis.com` ([F-SEC-01]); `Referrer-Policy: no-referrer` en todos los origins criptográficos ([F-SEC-03]).

## Alternativas consideradas

- **Google Identity Services (JS de Google):** descartado en los origins criptográficos, porque sería JavaScript de terceros en el origin de U o R (§4, §3.5).
- **Client secret con canje del código en el backend:** descartado; un secret no puede protegerse en un navegador y el backend pasaría a formar parte del flujo de U (CF-03).
- **Flujo implícito como opción principal:** Google lo marca como legacy; queda sólo como alternativa si code + PKCE no funciona sin backend (§4).
- **Drive como único backup:** descartado; el `appDataFolder` sólo es accesible con el cliente OAuth de la plataforma y se borra si el usuario desinstala la app, mientras que la salida soberana debe funcionar aunque la plataforma desaparezca ([F-KEY-06], §3.5).

## Consecuencias

- El backend nunca es custodio de U ni de R, y Wallet y Recovery quedan con almacenamiento aislado entre sí.
- La redirección obliga a conectar Drive antes de generar o desbloquear claves, y el token vive sólo en memoria: cada sesión vuelve a pasar por OAuth para acceder a Drive.
- Antes de que la Safe llegue a ACTIVE, U y R necesitan cada una al menos un backup independiente de la plataforma (archivo cifrado, QR del sobre o 17 palabras); la restauración en un dispositivo nuevo funciona desde Drive, archivo, QR o palabras ([F-KEY-10]).
- Riesgos residuales: la deprecación del flujo OAuth elegido (registrada en P28.T03) y el borrado del `appDataFolder`, mitigado por el chequeo de salud y el backup independiente obligatorio.
- Como el login de Google no se puede automatizar, el cliente Drive de cada app se prueba contra la API real con una cuenta de prueba autorizada una vez (`GOOGLE_DRIVE_TEST_*`), en cada `pnpm ci:local` y en CI, sin saltearse nunca (R-14, P22.T04).
- El resultado del spike (request y response sin secretos) se registra en este ADR en P17.T02.
- Los clientes OAuth de staging y producción para los dominios reales, con publicación y verificación de marca, se configuran en el despliegue final (H-03).

## Verificación

- P17.T02 — spike de OAuth con los clientes locales reales, resultado registrado en este ADR e implementación de `drive/` con verificación post-subida y chequeo de salud.
- P17.T05 — onboarding de U en orden: conectar Drive → generar U → subir y verificar → backup independiente obligatorio.
- P17.T06 — chequeo periódico no bloqueante del backup en Drive.
- P17.TST — Drive contra la API real con la cuenta de prueba (`GOOGLE_DRIVE_TEST_*`).
- P17.T09 y P19.T08 — restauración de U y de R en un dispositivo nuevo, incluida la vía Drive.
- P19.T03 — backups de R interna en el Drive de Recovery.
- P22.T03 — el access token de Drive no aparece en `localStorage`, `sessionStorage` ni IndexedDB.
- P22.T04 — `test:drive-live` de cada app: subir, leer, reemplazar y borrar en `appDataFolder` contra la API real.
- P00.T08 — PF-20 (clientes OAuth de Wallet y Recovery distintos y válidos para el origin) y PF-30 (credenciales de Drive de prueba).
- P28.T03 — riesgos residuales, incluida la deprecación del flujo OAuth elegido.
- Trazabilidad: RQ-31, RQ-88.
