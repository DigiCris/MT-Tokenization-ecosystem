# App Wallet

Frontend del trust domain de U (§8): React 19 + TypeScript 6.0 + Vite 8, sin librerías de UI ni wagmi/conectores
([F-SEC-07]), proyecto independiente con su propio lockfile (sin código compartido con Recovery). P16 deja la base
endurecida; las pantallas de cuenta, claves y operación llegan en P17–P18.

## Scripts

| Comando                      | Qué hace                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                   | Servidor de desarrollo en `http://localhost:5173` (`WALLET_ORIGIN`) con la CSP y Trusted Types aplicados (en dev la CSP suma sólo el websocket de HMR y `'unsafe-inline'` en `style-src`, porque Vite inyecta el CSS como `<style>`). |
| `pnpm build`                 | Design tokens verificados + build de producción en `dist/` con SRI, contratos del sistema del entorno, headers resueltos y release manifest.                                                                                          |
| `pnpm build:release`         | `build` + firma Ed25519 del manifest con la clave de release de Wallet (se niega con el árbol sucio).                                                                                                                                 |
| `pnpm preview`               | `vite preview` del build en `http://localhost:4173` (`MTW_PREVIEW_PORT`) con los headers exactos del entorno y 403 a scripts de service worker.                                                                                       |
| `pnpm lint`                  | ESLint (con las prohibiciones de [F-SEC]) + los casos prohibidos de `lint-fixtures/` + Prettier.                                                                                                                                      |
| `pnpm typecheck`             | `tsc` de la app, de los workers y del build/scripts/tests (tres tsconfigs).                                                                                                                                                           |
| `pnpm test`                  | Vitest con cobertura: lógica de seguridad, contratos fijados, Argon2id (RFC 9106 y cruzado con Node), dependencias sin wagmi y dos builds de release reales (sin inline, SRI, manifest firmado y reproducible).                       |
| `pnpm test:browser [filtro]` | Compila y corre Playwright (Chromium) contra `vite preview`: `security/headers` y `security/trusted-types`.                                                                                                                           |
| `pnpm verify:manifest`       | Verifica `dist/` contra el manifest firmado (`--public-key <pem>` o la clave pública del entorno).                                                                                                                                    |

## Configuración por entorno

`MTW_ENV` (`local` por defecto, `ci`, `staging`, `production`) elige el entorno; `build/config.ts` toma sólo variables
públicas: `WALLET_API_BASE_URL`, `WALLET_FRONTEND_RPC_URL`, `RECOVERY_ORIGIN`, `GOOGLE_CLIENT_ID_WALLET`,
`GOOGLE_OAUTH_REDIRECT_URI_WALLET` y `SIGNER_ATTESTATION_PUBLIC_KEY` (del entorno del proceso; en `local` también de
`wallet/.env`; en `local`/`ci`, defaults de `wallet/.env.example`). Staging y producción exigen cada valor con https.
Los contratos del sistema salen de `contracts/deployments/<env>.json` (`MTW_DEPLOYMENT_FILE` para otra ruta).

## Seguridad del build y del runtime

- CSP de [F-SEC-01] y headers de [F-SEC-03] desde `build/headers.json` (hosts por entorno), aplicados por `vite preview`
  y emitidos en `dist/.well-known/security-headers.json` para el contenedor `wallet-web` (P26).
- Al arrancar (`src/security/boot.ts`): comprobación de que la CSP y Trusted Types se aplican (si no, la app no opera),
  política única `mtw-default` con la allowlist de workers resuelta en el build, kill-switch de service workers y
  reporte de violaciones a `POST /api/v1/security/csp-report` sin datos sensibles.
- Build reproducible (nombres por hash, sin sourcemaps ni assets inline, `SOURCE_DATE_EPOCH` = fecha del commit), SRI
  en cada `<script>`/`<link>`, `system-contracts.<env>.json` embebido y publicado, release manifest JCS en
  `dist/.well-known/release-manifest.json(.sig)` y SBOM CycloneDX (`ci/scripts/sbom.sh`).
- Reproducibilidad de punta a punta: `bash ci/scripts/repro-build.sh wallet`.
