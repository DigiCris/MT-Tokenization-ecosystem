# shellcheck shell=bash
# Funciones comunes de los scripts de CI de wallet/ (P02). Mismo comportamiento en local
# (pnpm ci:local) y en GitHub Actions. Nunca imprimen secretos.
set -euo pipefail
CI_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WALLET_ROOT="$(cd "$CI_SCRIPTS_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$WALLET_ROOT/.." && pwd)"
export WALLET_ROOT REPO_ROOT
# shellcheck source=../../scripts/env.sh
source "$WALLET_ROOT/scripts/env.sh"

section() { printf '\n==> %s\n' "$*"; }

# Termina con éxito explícito si el proyecto todavía no existe (las fases lo crean).
skip_if_missing() { # <ruta relativa a wallet/> <fase>
  if [ ! -e "$WALLET_ROOT/$1" ]; then
    echo "SKIP: proyecto no creado aún (fase $2): wallet/$1"
    exit 0
  fi
}

has_script() { # <dir> <script>
  node -e "process.exit(require(process.argv[1]).scripts?.[process.argv[2]] ? 0 : 1)" "$1/package.json" "$2"
}

run_if_script() { # <dir> <script> [args...]
  local dir="$1" script="$2"; shift 2
  if has_script "$dir" "$script"; then
    section "${dir#"$WALLET_ROOT"/}: pnpm run $script"
    (cd "$dir" && pnpm run -s "$script" "$@")
  fi
}

# Proyecto TypeScript: install congelado → lint → typecheck → tests → cobertura → build.
ci_node_project() { # <ruta relativa> <fase>
  local rel="$1" phase="$2" dir
  skip_if_missing "$rel/package.json" "$phase"
  dir="$WALLET_ROOT/$rel"
  section "$rel: pnpm install --frozen-lockfile"
  (cd "$dir" && pnpm install --frozen-lockfile)
  run_if_script "$dir" lint
  run_if_script "$dir" typecheck
  run_if_script "$dir" test
  run_if_script "$dir" test:integration
  run_if_script "$dir" test:coverage
  run_if_script "$dir" build
}

# Insumos públicos del build de los frontends en el entorno `ci` (P16): el deployment real de la red ci (DeployCore +
# VerifyDeployment sobre un Anvil efímero que forkea el bloque fijado, deploy-ephemeral.sh) y una clave pública de
# atestación del signer efímera (el build sólo embebe la pública; no hay signer que la use en este entorno). Con
# MTW_FRONTEND_INPUTS=<dir> los toma de ahí: los builds del chequeo de reproducibilidad reciben los mismos.
frontend_ci_inputs() {
  export MTW_ENV=ci
  if [ -n "${MTW_FRONTEND_INPUTS:-}" ]; then
    MTW_DEPLOYMENT_FILE="$MTW_FRONTEND_INPUTS/contracts.json"
    SIGNER_ATTESTATION_PUBLIC_KEY="$(cat "$MTW_FRONTEND_INPUTS/signer-attestation.pub")"
    export MTW_DEPLOYMENT_FILE SIGNER_ATTESTATION_PUBLIC_KEY
    return 0
  fi
  export MTW_DEPLOYMENT_FILE="$WALLET_ROOT/contracts/deployments/ci.json"
  if [ ! -f "$MTW_DEPLOYMENT_FILE" ]; then
    # En CI el RPC del fork llega del secret BASE_RPC_URL; en local, de wallet/.env sin imprimirlo.
    if [ -z "${FORK_RPC_URL:-}" ]; then FORK_RPC_URL="${BASE_RPC_URL:-}"; fi
    if [ -z "$FORK_RPC_URL" ] && [ -f "$WALLET_ROOT/.env" ]; then
      FORK_RPC_URL="$(node "$WALLET_ROOT/scripts/lib/env-value.mjs" BASE_RPC_URL 2>/dev/null || true)"
    fi
    export FORK_RPC_URL
    section "contratos del sistema de la red ci para los builds (Anvil efímero sobre el fork)"
    (cd "$WALLET_ROOT/contracts" && { [ -d dependencies ] || forge soldeer install; })
    bash "$CI_SCRIPTS_DIR/deploy-ephemeral.sh"
  fi
  if [ -z "${SIGNER_ATTESTATION_PUBLIC_KEY:-}" ]; then
    SIGNER_ATTESTATION_PUBLIC_KEY="$(node -e "process.stdout.write(require('node:crypto').generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))")"
    export SIGNER_ATTESTATION_PUBLIC_KEY
  fi
}

# Headless shell de Chromium de la versión fijada de @playwright/test (en CI, con sus dependencias del sistema).
ensure_playwright_browser() { # <dir>
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    (cd "$1" && pnpm exec playwright install --with-deps --only-shell chromium)
  else
    (cd "$1" && pnpm exec playwright install --only-shell chromium)
  fi
}

# App de frontend (P16): design tokens verificados contra su lock, install congelado, lint (con los casos prohibidos de
# lint-fixtures/), typecheck, tests (unit y del build de release), build, tests de navegador contra `vite preview` del
# build y SBOM CycloneDX.
ci_frontend_app() { # <ruta relativa> <fase>
  local rel="$1" phase="$2" dir
  skip_if_missing "$rel/package.json" "$phase"
  dir="$WALLET_ROOT/$rel"
  frontend_ci_inputs
  section "$rel: design tokens (SHA-256 contra design-tokens.lock.json)"
  (cd "$dir" && node scripts/sync-design-tokens.mjs --check)
  section "$rel: vectores iguales a los de contracts/ (§10, regla 2)"
  (cd "$dir" && node scripts/sync-vectors.mjs --check)
  if [ -f "$dir/scripts/sync-abis.mjs" ]; then
    section "$rel: ABIs iguales a los de contracts/out-abi (§10, regla 2)"
    (cd "$dir" && node scripts/sync-abis.mjs --check)
  fi
  section "$rel: pnpm install --frozen-lockfile"
  (cd "$dir" && pnpm install --frozen-lockfile)
  run_if_script "$dir" lint
  run_if_script "$dir" typecheck
  run_if_script "$dir" test
  # Servicios reales con la cuenta de prueba (Drive, P17.TST/P22.T04): obligatorios, nunca se saltean; sin credenciales
  # (GOOGLE_DRIVE_TEST_* en wallet/.env o en el environment de CI de la app) fallan.
  run_if_script "$dir" test:drive-live
  run_if_script "$dir" build
  section "$rel: navegador de Playwright (headless shell de la versión fijada)"
  ensure_playwright_browser "$dir"
  run_if_script "$dir" test:browser
  # Otra vez después de los tests de navegador: si alguno revocara en Google el token de la cuenta de prueba (la app lo
  # revoca al cerrar sesión y los helpers interceptan ese pedido), falla esta corrida y no la siguiente.
  if has_script "$dir" test:drive-live; then
    section "$rel: Drive real otra vez (el refresh token de prueba sigue vigente después de los tests de navegador)"
    (cd "$dir" && pnpm run -s test:drive-live)
  fi
  section "$rel: SBOM CycloneDX (syft)"
  bash "$CI_SCRIPTS_DIR/sbom.sh" "${rel#frontend/}"
}

image_ref() { # <nombre en versions.json securityImages>
  node -e "console.log(require(process.argv[1]).securityImages[process.argv[2]])" "$WALLET_ROOT/scripts/tools/versions.json" "$1"
}

# docker_tool <imagen> [opciones de docker run...] -- [argumentos del comando]
docker_tool() {
  local ref; ref="$(image_ref "$1")"; shift
  local opts=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do opts+=("$1"); shift; done
  [ "${1:-}" = "--" ] && shift
  docker image inspect "$ref" >/dev/null 2>&1 || docker pull -q "$ref" >/dev/null
  docker run --rm "${opts[@]}" "$ref" "$@"
}
