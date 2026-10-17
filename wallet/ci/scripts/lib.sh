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
