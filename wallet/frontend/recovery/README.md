# App Recovery

Frontend del trust domain de R (§8): React 19 + TypeScript 6.0 + Vite 8, sin librerías de UI, proyecto independiente
con su propio lockfile (sin código compartido con Wallet) y con su acento visual propio. wagmi y los conectores
(MetaMask, Coinbase Wallet sólo EOA, WalletConnect) están declarados pero se importan sólo vía `import()` en
`src/external-wallet/` ([F-SEC-07]): los flujos de R interna nunca cargan ese chunk. P16 deja la base endurecida; las
pantallas de enrollment, recuperación, rotaciones, modo soberano, emergencia y migración llegan en P19.

## Scripts

| Comando                      | Qué hace                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                   | Servidor de desarrollo en `http://localhost:5174` (`RECOVERY_ORIGIN`) con la CSP y Trusted Types aplicados (en dev la CSP suma sólo el websocket de HMR y `'unsafe-inline'` en `style-src`). |
| `pnpm build`                 | Design tokens verificados + build de producción en `dist/` con SRI, contratos del sistema del entorno, headers resueltos y release manifest.                                                 |
| `pnpm build:release`         | `build` + firma Ed25519 del manifest con la clave de release de Recovery (distinta de la de Wallet).                                                                                         |
| `pnpm preview`               | `vite preview` del build en `http://localhost:4174` (`MTW_PREVIEW_PORT`) con los headers exactos del entorno.                                                                                |
| `pnpm lint`                  | ESLint (prohibiciones de [F-SEC] y wagmi/conectores sólo en `src/external-wallet/`) + `lint-fixtures/` + Prettier.                                                                           |
| `pnpm typecheck`             | `tsc` de la app, de los workers y del build/scripts/tests.                                                                                                                                   |
| `pnpm test`                  | Vitest con cobertura: lógica de seguridad, contratos fijados, Argon2id (R siempre 64 MiB), dos builds de release reales y el grafo del bundle (`test/bundle-graph.test.ts`).                 |
| `pnpm test:browser [filtro]` | Compila y corre Playwright (Chromium) contra `vite preview`: headers, Trusted Types y el chunk lazy de wallet externa bajo CSP/TT.                                                           |
| `pnpm verify:manifest`       | Verifica `dist/` contra el manifest firmado.                                                                                                                                                 |

## Configuración por entorno

Como en Wallet, con sus variables: `RECOVERY_API_BASE_URL`, `RECOVERY_FRONTEND_RPC_URL`, `WALLET_ORIGIN` (link de
regreso con R), `GOOGLE_CLIENT_ID_RECOVERY`, `GOOGLE_OAUTH_REDIRECT_URI_RECOVERY`, `WALLETCONNECT_PROJECT_ID` y
`SIGNER_ATTESTATION_PUBLIC_KEY`. La CSP no incluye `'wasm-unsafe-eval'` (Recovery no usa WASM); los endpoints de
WalletConnect se agregan a `connect-src` cuando se verifican en P19.

## Seguridad

Mismo endurecimiento que Wallet (arranque con CSP/TT verificados, política `mtw-default`, kill-switch de service
workers, reporte de violaciones, SRI, manifest firmado, SBOM y build reproducible: `bash ci/scripts/repro-build.sh
recovery`). Las dependencias de wallet externa quedan detrás del chunk lazy (lo verifican el grafo del bundle, ESLint
y Semgrep) y la regla de [F-SEC-09] (`bash ci/scripts/check-shared-deps.sh`) impide publicar en 72 h el mismo upgrade
de `@noble/*`, `@scure/*` o `viem` en las dos apps.
