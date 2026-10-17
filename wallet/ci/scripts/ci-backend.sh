#!/usr/bin/env bash
# CI del backend (API, worker, watcher, indexer, gas tank) — P08 en adelante. Los tests de integración usan Docker
# (Testcontainers: PostgreSQL 18, Valkey 9 y Mailpit fijados por digest) y Anvil sobre el fork de Base (BASE_RPC_URL).
#
# Tests contra servicios externos con cuota (`pnpm test:live`: Mailgun sandbox ~300 envíos/día y Gmail API): corren
# cuando el cambio toca email/autenticación, en la corrida diaria programada y a pedido (workflow_dispatch o
# MTW_LIVE_TESTS=1); MTW_LIVE_TESTS=0 los omite. Sin una base de comparación conocida, corren (fail-safe).
source "$(dirname "$0")/lib.sh"
skip_if_missing backend/app/package.json P08
section "backend/app: vectores y ABIs iguales a los de contracts/ (§10, regla 2)"
node "$WALLET_ROOT/backend/app/scripts/sync-contract-artifacts.mjs" --check
ci_node_project backend/app P08

LIVE_PATHS='^wallet/backend/app/(src/email/|src/auth/|src/api/routes/v1/auth\.ts|src/api/plugins/auth\.ts|src/config/env\.ts|test/email/|test/helpers/(gmail|live-env|mailgun-live|email-fixtures|email-pipeline|account-env)\.ts|package\.json|pnpm-lock\.yaml)|^wallet/ci/scripts/ci-backend\.sh$|^\.github/workflows/wallet-backend\.yml$'

# Base contra la que se compara el cambio (vacío si no se puede determinar).
live_diff_base() {
  local zero='0000000000000000000000000000000000000000'
  if [ -n "${GITHUB_BASE_REF:-}" ]; then
    git -C "$REPO_ROOT" merge-base "origin/$GITHUB_BASE_REF" HEAD 2>/dev/null && return 0
  elif [ -n "${GITHUB_EVENT_BEFORE:-}" ] && [ "$GITHUB_EVENT_BEFORE" != "$zero" ]; then
    git -C "$REPO_ROOT" cat-file -e "$GITHUB_EVENT_BEFORE^{commit}" 2>/dev/null && { echo "$GITHUB_EVENT_BEFORE"; return 0; }
  fi
  git -C "$REPO_ROOT" merge-base origin/main HEAD 2>/dev/null || true
}

live_changed_paths() {
  local base="$1"
  git -C "$REPO_ROOT" diff --name-only "$base" HEAD
  # En local (ci:local) también cuenta lo que todavía no se commiteó.
  if [ -z "${GITHUB_ACTIONS:-}" ]; then
    git -C "$REPO_ROOT" diff --name-only HEAD
    git -C "$REPO_ROOT" ls-files --others --exclude-standard
  fi
}

live_tests_needed() {
  case "${MTW_LIVE_TESTS:-auto}" in
    1 | always) echo "MTW_LIVE_TESTS=${MTW_LIVE_TESTS}"; return 0 ;;
    0 | never) echo "MTW_LIVE_TESTS=${MTW_LIVE_TESTS}"; return 1 ;;
  esac
  case "${GITHUB_EVENT_NAME:-}" in
    schedule | workflow_dispatch) echo "evento ${GITHUB_EVENT_NAME}"; return 0 ;;
  esac
  local base
  base="$(live_diff_base)"
  if [ -z "$base" ]; then echo "sin base de comparación"; return 0; fi
  if live_changed_paths "$base" | grep -qE "$LIVE_PATHS"; then echo "el cambio toca email/autenticación"; return 0; fi
  echo "el cambio no toca email/autenticación"
  return 1
}

section "backend/app: tests contra servicios reales con cuota (Mailgun, Gmail API)"
if reason="$(live_tests_needed)"; then
  echo "corren: $reason"
  (cd "$WALLET_ROOT/backend/app" && pnpm run -s test:live)
else
  echo "SKIP: $reason (corren en la corrida diaria y a pedido: workflow_dispatch o MTW_LIVE_TESTS=1)"
fi
