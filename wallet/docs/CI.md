# CI de wallet/

Pipelines por trust domain (P02). La lógica vive en `wallet/ci/scripts/*.sh` y es la misma en GitHub Actions y en local (`pnpm ci:local`); los workflows sólo preparan el runner, instalan la toolchain fijada y llaman al script del área. Ningún workflow despliega a una red real ni publica artefactos: el único `--broadcast` es el de `DeployCore` sobre un Anvil efímero local dentro del job de contratos (red `ci`), y `ci/tests/workflows.test.mjs` lo verifica.

## Matriz de workflows y jobs

| Workflow | Disparadores | Jobs | Script | Environment (secretos) |
|---|---|---|---|---|
| `wallet-contracts` | push/PR con cambios en contratos, `config/chains`, `ci`, toolchain, `scripts/deploy-core`, `scripts/env.sh`, `scripts/lib` | `contracts`: `forge build --sizes`, `forge test --profile ci` completo en los dos modos de policy (`POLICY_MODE=restricted` y `bootstrap`: unit, integración, fork, adversarial, fuzz e invariantes), ABIs y vectores cruzados sin cambios al regenerar, cobertura (≥ 95 % líneas, ≥ 90 % ramas en `src/`), Slither (`--fail-medium` y baseline de hallazgos suprimidos, `ci/scripts/slither-baseline.mjs`) y `DeployCore` + `VerifyDeployment` de punta a punta sobre un Anvil efímero (red `ci`, `ci/scripts/deploy-ephemeral.sh`) | `ci-contracts.sh` | `wallet-ci-contracts` (`BASE_RPC_URL`) |
| `wallet-backend` | push/PR en `backend/app`, `backend/integrity-monitor`, vectores, ABIs (`contracts/out-abi`), `config`, init de Postgres (`infra/local/postgres`), `ci`, toolchain | `backend`: vectores y ABIs iguales a `contracts/`, install congelado, lint, typecheck, tests (unit, integración con PostgreSQL 18 y Valkey 9 por Testcontainers y Anvil sobre el fork, API y seguridad) con cobertura, build; `integrity-monitor` | `ci-backend.sh`, `ci-integrity-monitor.sh` | `wallet-ci-backend` (`BASE_RPC_URL`, `EMAIL_PROVIDER_*`, `EMAIL_TEST_*`) |
| `wallet-signer` | push/PR en `backend/signer`, vectores, `config`, `ci`, toolchain | `signer` | `ci-signer.sh` | `wallet-ci-signer` (`BASE_RPC_URL`) |
| `wallet-frontend-wallet` | push/PR en `frontend/wallet`, `design-tokens`, vectores, `config`, `ci`, toolchain | `frontend-wallet` | `ci-frontend-wallet.sh` | `wallet-ci-frontend-wallet` (`BASE_RPC_URL`, `GOOGLE_DRIVE_TEST_*`) |
| `wallet-frontend-recovery` | push/PR en `frontend/recovery`, `design-tokens`, vectores, `config`, `ci`, toolchain | `frontend-recovery` | `ci-frontend-recovery.sh` | `wallet-ci-frontend-recovery` (`BASE_RPC_URL`, `WALLETCONNECT_PROJECT_ID`, `GOOGLE_DRIVE_TEST_*`) |
| `wallet-security` | push/PR en `wallet/**`, workflows `wallet-*`, `CODEOWNERS`; semanal | `docs` (tests del preflight y de CI, `check-docs`, wordlist, política de pnpm); `security` (gitleaks sobre la historia completa, OSV-Scanner, `pnpm audit --prod`, Semgrep, zizmor) | `ci-docs.sh`, `ci-security.sh` | — |
| `wallet-repro-build` | push/PR en `frontend/**`, `ci`, toolchain | `build-1` y `build-2` (jobs y runners distintos) + `compare` de los release manifests | `ci-repro-build.sh --single` / `--compare` | — |
| `wallet-e2e` | PR con label `e2e`; nightly (04:41 UTC); manual | `e2e`: Playwright + acceptance full-system sobre el fork | `ci-e2e.sh` | `wallet-ci-e2e` (todos los de servicios reales) |
| `wallet-ci-gate` | todo PR hacia `main` | `wallet-ci-gate`: check requerido de la protección de `main` | `ci-gate.sh` | — |

Mientras un proyecto no existe, su script imprime `SKIP: proyecto no creado aún (fase Pxx)` y termina en verde.

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
