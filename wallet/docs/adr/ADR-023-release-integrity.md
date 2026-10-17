# ADR-023 — Integridad de releases y pausa de cooperación de S

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-023), §5.1 (regla 3), §7.15 ([W-03], [W-04]), §8.5 ([F-SEC-01] a [F-SEC-09]), §9.2 (A20), §9.3, P20; V9 §17; prompt §3 (Frontend); CF-10

## Contexto

V9 §17 exige, para los origins criptográficos, builds reproducibles y assets self-hosted; CSP estricta, SRI, Trusted Types, lockfiles fijados y SBOM por build; nada de JavaScript de terceros; service workers deshabilitados para evitar la persistencia de código comprometido; un manifest firmado con releaseId, commit y SHA-256 de HTML, JS, WASM, CSS y assets; y monitores independientes que comparen el deploy con el manifest, de modo que una discrepancia pause la cooperación de S para esa plataforma. El prompt §3 repite esa lista para el frontend.

Cada frontend se sirve desde un servidor propio (ADR-022): un compromiso del root de ese servidor, o de su cuenta de hosting, podría alterar lo que se sirve en el origin de esa app. Por eso las claves de release quedan fuera de todos los hosts de producción y hay un control off-host (CF-10), además del monitor local del host del backend.

## Decisión

Integridad de releases: builds reproducibles, SRI, CSP estricta, Trusted Types (una política con allowlist de workers), sin service workers, manifest firmado con Ed25519 por app (claves de release distintas, guardadas sólo en el GitHub Environment de cada app, nunca en la VPS), SBOM CycloneDX (syft) y contratos del sistema embebidos por entorno. Un **integrity monitor** (contenedor propio, clave propia) emite atestaciones firmadas que el signer exige para cooperar (MISMATCH pausa de inmediato; UNREACHABLE pausa tras 15 min de gracia, con alerta) y un **chequeo off-host** programado en GitHub Actions verifica los mismos manifests y alerta aunque el host esté comprometido. Riesgo residual: servir JavaScript distinto sólo a ciertos usuarios no es detectable por los monitores.

Detalle del hardening ([F-SEC]):

- **CSP** ([F-SEC-01]), emitida como header HTTP por el servidor estático propio de cada frontend (contenedor `wallet-web`/`recovery-web` en producción, `vite preview` en local):

  ```text
  default-src 'none'; script-src 'self' [Wallet: 'wasm-unsafe-eval' — requerido por OPAQUE (WASM); Recovery: sin WASM]; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' <API host de la app> <RPC del frontend> https://www.googleapis.com https://oauth2.googleapis.com [Recovery: + endpoints de WalletConnect verificados en P19]; worker-src 'self'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; manifest-src 'none'; require-trusted-types-for 'script'; trusted-types mtw-default; upgrade-insecure-requests
  ```
- **Trusted Types** ([F-SEC-02]): una sola política `mtw-default`, cuyo `createScriptURL` sólo devuelve URLs de una allowlist generada en build (los Web Workers con hash, como el de Argon2id) y cuyos `createHTML`/`createScript` lanzan error.
- **Headers** ([F-SEC-03]): HSTS (2 años, preload), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` mínima, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin` y `Cross-Origin-Embedder-Policy: require-corp`.
- **Sin service workers** ([F-SEC-04]): el servidor estático responde 403 a requests con `Service-Worker: script` y la app desregistra cualquier SW existente al iniciar.
- **Sin terceros** ([F-SEC-05]): sin third-party JS, analytics ni GTM, fuentes self-hosted y dependencias con versión exacta.
- **Build** ([F-SEC-06], [W-04]): builds reproducibles (`SOURCE_DATE_EPOCH`, toolchain fijado) verificados compilando dos veces en runners distintos; SRI en todo `<script>`/`<link>`; manifest JCS `{app, environment, releaseId, gitCommit, sourceDateEpoch, files: [{path, sha256, size}]}` firmado con la clave de release de esa app y publicado en `/.well-known/release-manifest.json(.sig)`; SBOM CycloneDX por build.
- **Contratos del sistema** ([F-SEC-08]): cada build embebe `system-contracts.<env>.json` (address y codehash de los contratos del sistema) y la clave pública de atestación del signer; si el backend informa direcciones distintas, la app se niega a operar.
- **Dependencias comunes** ([F-SEC-09]): un upgrade de `@noble/*`, `viem` o `@scure/*` no se publica en Wallet y Recovery en la misma ventana (mínimo 72 h) y requiere aprobación de cada dominio.

Detalle del monitoreo (P20):

- **Integrity monitor** (P20.T02): cada 60 s, por app y entorno, descarga y verifica manifest y firma, el SHA-256 de cada archivo listado, los headers y el SRI de `index.html`, y detecta archivos o scripts no listados; registra `integrity_status` y emite la atestación `IntegrityAttestation` ([W-03]).
- **Chequeo off-host** (P20.T02.a): workflow programado de GitHub Actions cada 15 min contra las URLs públicas, con las claves públicas de release del repositorio; alerta por email o webhook y no depende del host de producción (no pausa al signer).
- **Signer** (P20.T03): con `INTEGRITY_REQUIRED=true` (staging/producción) exige atestaciones OK de ambas apps con antigüedad ≤ 5 min; ante MISMATCH deja de cooperar de inmediato (`COOPERATION_PAUSED`); ante UNREACHABLE alerta y concede 15 min de gracia antes de pausar. El camino soberano no se afecta.
- **Reanudación** (P20.T04): sólo con atestación OK + acción de dos operadores registrada.

## Alternativas consideradas

- **Service workers en los origins criptográficos:** descartados por V9 §17, para evitar la persistencia de código comprometido.
- **Relajar Trusted Types para un conector o librería que lo requiera:** descartado; se excluye la librería y no se relaja la política ([F-SEC-02]).
- **Claves de release en la VPS o en el backend:** descartado; el backend y el signer no tienen credenciales para publicar ni firmar frontends (§5.1, regla 3), y las claves de release viven fuera del host (CF-10).
- **Sólo un monitor dentro del host:** insuficiente frente a un compromiso del root del host; por eso se agrega el chequeo off-host (CF-10).

## Consecuencias

- A20: un frontend alterado respecto de su manifest pausa la cooperación de S, sin afectar el camino soberano U+R.
- Un backend comprometido no puede firmar ni publicar frontends, y una app se niega a operar si el backend informa contratos distintos de los embebidos.
- Riesgo residual (§9.3): servir JavaScript distinto sólo a ciertos usuarios no es detectable por los monitores; se mitiga con builds reproducibles, SRI y un servidor estático propio por dominio.
- Operación: kill-switch de cooperación con comando firmado por dos operadores (P26.T16), reanudación con doble aprobación y rotación de las claves de release con overlap en el monitor (P26.T14).
- La CSP estricta impide scripts y estilos inline: el build fija `build.modulePreload.polyfill = false` y no emite inline (P16.T05).

## Verificación

- P16.T04 — Trusted Types `mtw-default`, kill-switch de service workers y reporte de violaciones CSP.
- P16.T05 — headers por app aplicados por `vite preview` y por el contenedor estático propio.
- P16.T06 y P16.T07 — build reproducible con manifest firmado y SBOM CycloneDX.
- P16.T09 — `system-contracts.<env>.json` embebido y rechazo de direcciones distintas informadas por el backend.
- P16.T10 — regla de dependencias comunes con ventana de 72 h.
- P16.TST, P16.SEC y P16.MAN — SRI, manifests idénticos en dos builds, headers, TT y ausencia de requests a terceros.
- P20.T01 a P20.T04 — claves de release distintas, integrity monitor, chequeo off-host, pausa del signer y reanudación con doble aprobación.
- P20.TST, P20.SEC y P20.MAN — archivo alterado → pausa en ≤ 2 ciclos, firma de manifest inválida → pausa, monitor caído → fail-closed; claves privadas de release ausentes del backend.
- P22.T03 — cero requests fuera de la allowlist, cero violaciones CSP/TT y sin service workers.
- P23.T02 — mismatch de integridad → pausa de S en el acceptance.
- P25.T08 — `system-contracts.staging.json` embebido y cubierto por el manifest.
- P26.T11 y P26.T17.f — headers en el ensayo de producción; integrity monitor fail-closed y chequeo off-host activos.
- P30.T04 y P30.SEC — integridad verificada en el ensayo de producción y kill-switch probado.
- Trazabilidad: RQ-19, RQ-86.
