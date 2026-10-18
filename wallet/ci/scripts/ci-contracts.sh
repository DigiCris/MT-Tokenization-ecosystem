#!/usr/bin/env bash
# CI de contratos (P02.T02): build con tamaños, tests (unit, integración, fork, fuzz, invariants),
# cobertura con umbrales (≥ 95 % líneas, ≥ 90 % ramas en src/), Slither (falla en High/Medium) y
# DeployCore + VerifyDeployment de punta a punta sobre un Anvil efímero (P05.T05), suites adversarial e
# invariantes en los dos modos de policy (P07.T09) y regeneración estable de ABIs y vectores (P07.T05/T06).
source "$(dirname "$0")/lib.sh"
skip_if_missing contracts/foundry.toml P03
# Fork tests: en CI FORK_RPC_URL llega del secret BASE_RPC_URL; en local se toma de wallet/.env sin imprimirlo.
if [ -z "${FORK_RPC_URL:-}" ] && [ -f "$WALLET_ROOT/.env" ]; then
  FORK_RPC_URL="$(node "$WALLET_ROOT/scripts/lib/env-value.mjs" BASE_RPC_URL 2>/dev/null || true)"
  export FORK_RPC_URL
fi
cd "$WALLET_ROOT/contracts"
# El RPC del fork es compartido con los jobs de backend y signer: si la corrida falla por un límite de ritmo del
# proveedor (429 en vm.createSelectFork), se vuelven a correr sólo los tests fallidos (`--rerun`) tras una espera, hasta
# 3 veces. Cualquier otra falla no se reintenta. (Los flags de reintento de forge exigen --rpc-url, que forkearía todas
# las suites, y no tienen clave en foundry.toml.)
RATE_LIMITED='HTTP error 429|error code 429|429 Too Many|too many requests|compute units per second|rate limit'
forge_test_with_rerun() { # <POLICY_MODE>
  local log attempt
  log="$(mktemp)"
  if POLICY_MODE="$1" forge test --profile ci 2>&1 | tee "$log"; then
    rm -f "$log"
    return 0
  fi
  for attempt in 1 2 3; do
    grep -qiE "$RATE_LIMITED" "$log" || break
    echo "falla por límite de ritmo del RPC del fork: se vuelven a correr los tests fallidos ($attempt/3)"
    sleep $((attempt * 30))
    if POLICY_MODE="$1" forge test --profile ci --rerun 2>&1 | tee "$log"; then
      rm -f "$log"
      return 0
    fi
  done
  rm -f "$log"
  return 1
}
section "dependencias (soldeer.lock)"
[ -d dependencies ] || forge soldeer install
bash script/verify-deps.sh
section "forge build --sizes"
forge build --sizes
# P07.T09: la suite completa en los dos modos de policy (las suites adversarial e invariantes toman POLICY_MODE;
# las de integración fijan su modo).
section "forge test --profile ci (POLICY_MODE=restricted, igual que producción)"
forge_test_with_rerun restricted
section "forge test --profile ci (POLICY_MODE=bootstrap)"
forge_test_with_rerun bootstrap
if [ -z "$(find src -name '*.sol' 2>/dev/null | head -1)" ]; then
  echo "SKIP: cobertura y Slither: todavía no hay contratos en src/ (fase P04)"
  exit 0
fi
# P07.T05/T06: regenerar las ABIs y los vectores cruzados no debe cambiar los archivos (en CI, los commiteados).
regen_unchanged() { # <directorio> <comando...>
  local dir="$1" before after
  shift
  before="$(find "$dir" -type f -print0 | sort -z | xargs -0 sha256sum)"
  "$@" >/dev/null
  after="$(find "$dir" -type f -print0 | sort -z | xargs -0 sha256sum)"
  if [ "$before" != "$after" ]; then
    echo "$dir cambió al regenerar con '$*': regenerar y commitear" >&2
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
    return 1
  fi
}
section "ABIs exportadas (out-abi) sin cambios al regenerar"
regen_unchanged out-abi bash script/export-abis.sh
section "vectores cruzados (test/vectors) sin cambios al regenerar"
regen_unchanged test/vectors bash script/export-vectors.sh
section "forge coverage (umbrales: líneas ≥ 95 %, ramas ≥ 90 % en src/)"
node "$WALLET_ROOT/ci/scripts/coverage-gate.mjs" contracts
section "slither"
slither . --config-file slither.config.json --fail-medium
section "slither: baseline de hallazgos suprimidos (contracts/slither-suppressed.json)"
node "$WALLET_ROOT/ci/scripts/slither-baseline.mjs" check
section "DeployCore + VerifyDeployment sobre un Anvil efímero (red ci)"
bash "$WALLET_ROOT/ci/scripts/deploy-ephemeral.sh"
