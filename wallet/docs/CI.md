# CI de wallet/

Pipelines por trust domain (P02). La lógica vive en `wallet/ci/scripts/*.sh` y es la misma en GitHub Actions y en local (`pnpm ci:local`); los workflows sólo preparan el runner, instalan la toolchain fijada y llaman al script del área. Ningún workflow despliega a una red real ni publica artefactos: los únicos `--broadcast` son los de `DeployCore` sobre Anvils efímeros locales que forkean Base (red `ci`): el del job de contratos, el que arma los insumos del build de los frontends (sus jobs y el job `inputs` del chequeo de reproducibilidad, siempre con `ci/scripts/deploy-ephemeral.sh`) y los que levantan los tests de integración del signer y del backend (`DEPLOYMENT_TAG`, JSON propio que se borra al leerlo); `ci/tests/workflows.test.mjs` verifica que ningún workflow despliegue.

## Matriz de workflows y jobs

| Workflow | Disparadores | Jobs | Script | Environment (secretos) |
|---|---|---|---|---|
| `wallet-contracts` | push/PR con cambios en contratos, `config/chains`, `ci`, toolchain, `scripts/deploy-core`, `scripts/env.sh`, `scripts/lib` | `contracts`: `forge build --sizes`, `forge test --profile ci` completo en los dos modos de policy (`POLICY_MODE=restricted` y `bootstrap`: unit, integración, fork, adversarial, fuzz e invariantes; si una corrida falla por un 429 del RPC compartido del fork se vuelven a correr sólo los tests fallidos con `--rerun`, hasta 3 veces, y la cobertura se reintenta con el mismo criterio), ABIs y vectores cruzados sin cambios al regenerar, cobertura (≥ 95 % líneas, ≥ 90 % ramas en `src/`), Slither (`--fail-medium` y baseline de hallazgos suprimidos, `ci/scripts/slither-baseline.mjs`) y `DeployCore` + `VerifyDeployment` de punta a punta sobre un Anvil efímero (red `ci`, `ci/scripts/deploy-ephemeral.sh`) | `ci-contracts.sh` | `wallet-ci-contracts` (`BASE_RPC_URL`) |
| `wallet-backend` | push/PR en `backend/app`, `backend/integrity-monitor`, `backend/signer` (sus shards participan de los tests de integración), contratos (`src`, `script`, vectores, `out-abi`), `config`, init de Postgres (`infra/local/postgres`), `ci`, toolchain, `scripts/deploy-core`, `scripts/env.sh`, `scripts/lib`; diario (06:17 UTC); manual | `backend`: vectores y ABIs iguales a `contracts/`, dependencias de `backend/signer` y de `contracts/`, install congelado, lint, typecheck, tests (unit, integración con PostgreSQL 18, Valkey 9 y Mailpit por Testcontainers, Anvil sobre el fork, shards reales del signer por mTLS, gas tank y onboarding de wallets por la API hasta ACTIVE sobre el sistema desplegado una vez por corrida, pipeline de operaciones con el worker S, finalidad, reorgs (`anvil_reorg`), indexer, reconciliación y resiliencia (fallas de RPC, dos workers, kill -9 del proceso `worker` en cada etapa, flush de Valkey), entrypoints `api`, `worker` y `gas-tank` como procesos, API y seguridad) con cobertura, build y, según el cambio, los tests contra servicios con cuota (ver abajo); `integrity-monitor` | `ci-backend.sh`, `ci-integrity-monitor.sh` | `wallet-ci-backend` (`BASE_RPC_URL`, `EMAIL_PROVIDER_*`, `EMAIL_TEST_*`) |
| `wallet-signer` | push/PR en `backend/signer`, contratos (`src`, `script`, vectores, `out-abi`), `config`, `ci`, toolchain, `scripts/deploy-core`, `scripts/env.sh`, `scripts/lib` | `signer`: vectores y ABIs iguales a `contracts/`, dependencias de `contracts/` (soldeer), install congelado, lint, typecheck, tests (unit, policy contra los vectores compartidos, reglas estáticas, keystore V3 con interoperabilidad con `cast`, integración con PostgreSQL 18 por Testcontainers y Anvil sobre el fork con el sistema desplegado una vez por corrida, API mTLS, ciclo de vida con `age`, seguridad) con cobertura (≥ 90 % de líneas en `src/chain` y `src/policy`), build y spec OpenAPI interna al día | `ci-signer.sh` | `wallet-ci-signer` (`BASE_RPC_URL`) |
| `wallet-frontend-wallet` | push/PR en `frontend/wallet`, `design-tokens`, vectores, `config`, `ci`, toolchain y, desde P17, lo que corre el stack de los tests de navegador (`backend/app`, `backend/signer`, `contracts/src` y `script`, `infra/local/postgres`, `docker-compose.yml`, `scripts/stack`, `scripts/lib`, `deploy-core`, `env.sh`) | `frontend-wallet` (checkout con historia completa): insumos del entorno `ci` (contratos de la red ci sobre un Anvil efímero y clave pública de atestación efímera), design tokens contra su lock (SHA-256), vectores cruzados iguales a `contracts/test/vectors` (§10, regla 2), install congelado, lint (con los casos prohibidos de `lint-fixtures/`), typecheck, tests (unit con cobertura ≥ 90 % por módulo de lógica, dependencias sin wagmi y dos builds de release reales: sin inline, SRI, manifest firmado y reproducible), `test:drive-live` (Drive real con la cuenta de prueba, nunca se saltea), build, tests de navegador con Playwright: contra `vite preview` (headers, Trusted Types, worker con TT forzado, Argon2id en el perfil móvil con CPU 4× en Chromium y WebKit) y, desde P17, contra el stack local real que levanta `scripts/stack/stack.mjs` en un proyecto de docker compose propio (PostgreSQL, Valkey, Mailpit, Anvil sobre el fork, contratos, policy, shards del signer, API, worker y gas tank): cuenta, onboarding con Drive real, desbloqueo, Password U, restauración y canarios; SBOM CycloneDX (syft) y la regla de dependencias criptográficas comunes de [F-SEC-09] | `ci-frontend-wallet.sh` | `wallet-ci-frontend-wallet` (`BASE_RPC_URL`, `GOOGLE_DRIVE_TEST_*`) |
| `wallet-frontend-recovery` | push/PR en `frontend/recovery`, `design-tokens`, vectores, `config`, `ci`, toolchain | `frontend-recovery`: lo mismo que Wallet más el grafo del bundle (wagmi y conectores sólo detrás del `import()` de `src/external-wallet/`) y el chunk lazy de wallet externa cargado bajo CSP/TT en el navegador | `ci-frontend-recovery.sh` | `wallet-ci-frontend-recovery` (`BASE_RPC_URL`, `WALLETCONNECT_PROJECT_ID`, `GOOGLE_DRIVE_TEST_*`) |
| `wallet-security` | push/PR en `wallet/**`, workflows `wallet-*`, `CODEOWNERS`; semanal | `docs` (tests del preflight y de CI, `check-docs`, wordlist, política de pnpm); `security` (gitleaks sobre la historia completa, OSV-Scanner, `pnpm audit --prod`, Semgrep, zizmor) | `ci-docs.sh`, `ci-security.sh` | — |
| `wallet-repro-build` | push/PR en `frontend/**`, `ci`, toolchain | `inputs` (contratos de la red ci sobre un Anvil efímero y clave pública de atestación: los mismos insumos para los dos builds) → `build-1` y `build-2` (jobs y runners distintos) → `compare` de los release manifests byte a byte. La firma Ed25519 la prueban `ci/scripts/repro-build.sh <app>` (local y `ci:local`) y los tests de cada app | `ci-repro-build.sh --inputs` / `--single` / `--compare` | `wallet-ci-contracts` (`BASE_RPC_URL`) sólo en `inputs` |
| `wallet-e2e` | PR con label `e2e`; nightly (04:41 UTC); manual | `e2e`: Playwright + acceptance full-system sobre el fork | `ci-e2e.sh` | `wallet-ci-e2e` (todos los de servicios reales) |
| `wallet-ci-gate` | todo PR hacia `main` | `wallet-ci-gate`: check requerido de la protección de `main` | `ci-gate.sh` | — |
| `wallet-review-tours` | manual (`gh workflow run wallet-review-tours.yml -f app=wallet -f tour=onboarding -f browsers=chromium,firefox`) | `review`: un recorrido de `test/browser/stack/review/` de la app contra el stack local y el fork en los navegadores pedidos (instalados con sus dependencias en el runner) y las capturas de cada pantalla como artefacto, para los checks manuales que hace el agente con un revisor independiente (R-14). En local, Firefox y WebKit corren en la imagen fijada de Playwright (`MTW_BROWSERS`, `scripts/lib/browser-server.mjs`) | `review-tour.sh` | `wallet-ci-frontend-<app>` |

Mientras un proyecto no existe, su script imprime `SKIP: proyecto no creado aún (fase Pxx)` y termina en verde.

### Tests contra servicios con cuota (backend)

`pnpm test:live` (`*.live.test.ts`) envía por la API real de Mailgun con el dominio sandbox y lee los códigos con la
Gmail API (P09.TST.g–h). El dominio sandbox admite **100 pedidos por día** (ventana móvil de 24 h; al agotarse,
Mailgun responde 429 `daily request limit (100) exceeded, try again after <fecha>`) y una corrida completa usa ~40
envíos (19 plantillas más los reenvíos por el rechazo DMARC del sandbox y los 3 flujos de entrega real), así que
`ci-backend.sh` los corre:

- en la corrida diaria programada y en `workflow_dispatch`;
- cuando el cambio toca el envío de email o los propios tests live (`src/email/`, `test/email/*.live.test.ts`, sus
  helpers, el propio `ci-backend.sh` o el workflow), comparando contra la base del PR o contra `github.event.before`
  en un push (checkout con `fetch-depth: 0`); sin base conocida, corren. Los flujos de autenticación que recorren
  (registro, verificación, reset, desbloqueo) se prueban además con Mailpit en la suite normal;
- en local (`pnpm ci:local`) con el mismo criterio, contando también los cambios sin commitear.

Los archivos live corren uno detrás del otro y esperan con la misma política de reintentos que el worker de email
(8 intentos, backoff exponencial desde 5 s). Si Mailgun informa que no acepta envíos hasta después de esa ventana
(cuota agotada), el test falla en el acto con la fecha (`MailgunQuotaExhaustedError`) y se vuelve a correr cuando se
libera la cuota.

`MTW_LIVE_TESTS=1` los fuerza y `MTW_LIVE_TESTS=0` los omite. Cuando no corren, el log dice por qué. El `schedule`
de GitHub sólo dispara en la rama por defecto: la corrida diaria empieza cuando el workflow llega a `main`.

### Presupuesto del RPC del fork

Todos los jobs que forkean Base usan la misma key (`BASE_RPC_URL`), que admite unos 500 CU/s en total: medido el
2026-10-18, 400 CU/s sostenidos pasan limpio, 800 CU/s devuelven 21 % de 429 y 1200 CU/s todo 429. Con varios
workflows en paralelo (backend, signer, contratos y los tests de navegador de Wallet) un Anvil llegó a agotar sus
reintentos con 429, así que cada consumidor tiene un tope (`--compute-units-per-second`) y reintentos con backoff:

| Consumidor | Tope | Reintentos |
|---|---|---|
| Anvil de cada archivo de tests de `backend/app` y `backend/signer` (hasta 4 workers) | 80 CU/s | 60, backoff 2 s |
| Anvil del stack aislado de los tests de navegador (`scripts/stack/stack.mjs`) | 80 CU/s | 30, backoff 2 s |
| Anvil efímero de los insumos de los builds (`ci/scripts/deploy-ephemeral.sh`) | 80 CU/s | 30, backoff 2 s |
| Fork tests de `forge test --profile ci` | 100 CU/s | reintento de la corrida si hubo 429 (`ci-contracts.sh`) |
| Anvil del compose para desarrollo local (`ANVIL_COMPUTE_UNITS_PER_SECOND`) | 330 CU/s | 30, backoff 2 s |

Con `MTW_ANVIL_LOG_DIR` cada Anvil de los tests del backend deja su log (con el endpoint redactado) y el workflow
`wallet-backend` lo sube como artefacto `anvil-logs` si el job falla. Esos logs mostraron además que
`waitForTransactionReceipt` de viem podía no volver a pedir el receipt de una tx ya minada: los tests esperan los
receipts consultándolos directamente (`waitForReceipt` de `test/helpers/fork.ts` y del helper de cadena del signer). Un segundo proveedor para CI
(`BASE_RPC_URL_SECONDARY` como secret) dividiría la carga entre dos keys.

## Reglas comunes

- Acciones de terceros fijadas por SHA de commit (`docs/VERSIONS.md#github-actions-fijadas-por-sha-de-commit-p02`); la única acción propia es `wallet/ci/actions/setup-toolchain` (composite).
- `permissions: contents: read` por defecto (el gate agrega `actions: read`); sin `pull_request_target`; `actions/checkout` con `persist-credentials: false`; `concurrency` por workflow y ref.
- Toolchain: `scripts/tools/bootstrap` instala Node, pnpm, Foundry, gitleaks y Slither con checksums verificados (ADR-032); caché de `wallet/.tools` por hash de `versions.json`.
- Deploy de punta a punta en el job de contratos: Anvil efímero en un puerto libre que forkea el bloque fijado, `LOCAL_SEED` aleatoria por corrida (nunca se imprime) y `scripts/deploy-core ci` (fondeo, `DeployCore --broadcast` y `VerifyDeployment`); no toca el Anvil del compose ni `deployments/local.json` (`docs/runbooks/deploy.md`).
- Caché RPC de Foundry por `FORK_BLOCK_NUMBER` (`~/.foundry/cache/rpc`, clave `foundry-rpc-v2-base-<bloque>`; `foundry.toml` cachea sólo endpoints remotos, nunca un Anvil local). Los fork tests usan `FORK_RPC_URL` (en CI, el secret `BASE_RPC_URL`; en local, el Anvil del compose) fijando siempre el bloque de `config/chains/base-mainnet.json`.
- Runners hospedados de GitHub (`ubuntu-24.04`), efímeros por diseño.
- Secretos: sólo por GitHub Environment y por área; los valores se enmascaran en los logs y ningún script los imprime. Los PRs desde forks no reciben secretos.
- `wallet/ci/tests/workflows.test.mjs` verifica estas reglas y que los filtros `paths` de cada workflow coincidan con `wallet/ci/areas.json`.

## Environments y secretos

| Environment | Secretos | Restricción de despliegue |
|---|---|---|
| `wallet-ci-contracts` | `BASE_RPC_URL` | ninguna (CI de branches y PRs) |
| `wallet-ci-backend` | `BASE_RPC_URL`, `EMAIL_PROVIDER_API_KEY`, `EMAIL_PROVIDER_DOMAIN`, `EMAIL_PROVIDER_BASE_URL`, `EMAIL_TEST_ADDRESS`, `EMAIL_TEST_GOOGLE_CLIENT_ID`, `EMAIL_TEST_GOOGLE_CLIENT_SECRET`, `EMAIL_TEST_GOOGLE_REFRESH_TOKEN` | ninguna |
| `wallet-ci-signer` | `BASE_RPC_URL` | ninguna |
| `wallet-ci-frontend-wallet` | `BASE_RPC_URL`, `GOOGLE_DRIVE_TEST_CLIENT_ID`, `GOOGLE_DRIVE_TEST_CLIENT_SECRET`, `GOOGLE_DRIVE_TEST_REFRESH_TOKEN` | ninguna |
| `wallet-ci-frontend-recovery` | `BASE_RPC_URL`, `WALLETCONNECT_PROJECT_ID`, `GOOGLE_DRIVE_TEST_CLIENT_ID`, `GOOGLE_DRIVE_TEST_CLIENT_SECRET`, `GOOGLE_DRIVE_TEST_REFRESH_TOKEN` | ninguna |
| `wallet-ci-e2e` | los de backend + frontends + `WALLETCONNECT_PROJECT_ID` | ninguna |
| `wallet-staging` | claves de firma de releases de staging (P20, P26.T02.a) | sólo tags `wallet-v*` |
| `wallet-production` | claves de firma de releases de producción (P20, P26.T02.a) | sólo tags `wallet-v*` |

El workflow de Recovery no declara el environment de Wallet ni viceversa, así que ninguno puede leer los secretos del otro. Los Environments no tienen reviewer obligatorio (la ejecución del planner no se frena); `wallet-staging` y `wallet-production` sólo aceptan tags `wallet-v*`, protegidos por un ruleset.

## Protección de `main` y de tags

Aplicadas con `gh api` (P02.T04):

- **Rama `main`:** check requerido `wallet-ci-gate`; PR obligatorio; commits firmados; la protección incluye a los administradores; sin force push ni borrado.
- **Gate:** los workflows de área se disparan sólo con sus rutas, y un check requerido que no se dispara bloquearía para siempre los PRs que no tocan `wallet/`. Por eso el único check requerido es `wallet-ci-gate`, que siempre corre: calcula las áreas tocadas por el PR con `ci/areas.json`, espera a que sus workflows terminen en verde para el mismo commit y pasa enseguida si el PR no toca `wallet/`.
- **Revisión de CODEOWNERS:** `.github/CODEOWNERS` asigna un revisor por trust domain. El repositorio pertenece a un usuario y tiene un único colaborador: GitHub no permite aprobar el PR propio, así que exigir la aprobación de un code owner bloquearía todo merge a `main`. La regla queda desactivada y se activa (`required_pull_request_reviews.require_code_owner_reviews = true`) en cuanto haya un segundo revisor; CODEOWNERS ya solicita la revisión automáticamente.
- **Tags `wallet-v*`:** ruleset que restringe creación, actualización y borrado, con bypass sólo para el rol de administrador del repositorio.

## Required checks

| Check | Dónde |
|---|---|
| `wallet-ci-gate` | protección de `main` (único check requerido) |
| `contracts`, `backend`, `integrity-monitor`, `signer`, `frontend-wallet`, `frontend-recovery`, `docs`, `security`, `build-1`, `build-2`, `compare` | exigidos indirectamente por el gate según las áreas tocadas |

## Runner local

```bash
cd wallet
pnpm ci:local          # todas las áreas en orden (ci/scripts/ci-all.sh); falla si alguna falla
bash ci/scripts/ci-contracts.sh    # un área
bash ci/scripts/ci-security.sh     # escaneos de seguridad
```

Requiere Docker (imágenes de seguridad fijadas por digest, `scripts/tools/versions.json`) y, para los fork tests, `FORK_RPC_URL` o el Anvil local levantado (`pnpm fork:start`).
