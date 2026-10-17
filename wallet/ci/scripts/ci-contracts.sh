#!/usr/bin/env bash
# CI de contratos (P02.T02): build con tamaños, tests (unit, integración, fork, fuzz, invariants),
# cobertura con umbrales (≥ 95 % líneas, ≥ 90 % ramas en src/) y Slither (falla en High/Medium).
source "$(dirname "$0")/lib.sh"
skip_if_missing contracts/foundry.toml P03
# Fork tests: en CI FORK_RPC_URL llega del secret BASE_RPC_URL; en local se toma de wallet/.env sin imprimirlo.
if [ -z "${FORK_RPC_URL:-}" ] && [ -f "$WALLET_ROOT/.env" ]; then
  FORK_RPC_URL="$(node "$WALLET_ROOT/ci/github/env-value.mjs" BASE_RPC_URL 2>/dev/null || true)"
  export FORK_RPC_URL
fi
cd "$WALLET_ROOT/contracts"
section "dependencias (soldeer.lock)"
[ -d dependencies ] || forge soldeer install
bash script/verify-deps.sh
section "forge build --sizes"
forge build --sizes
section "forge test --profile ci"
FOUNDRY_PROFILE=ci forge test
section "forge coverage (umbrales: líneas ≥ 95 %, ramas ≥ 90 % en src/)"
node "$WALLET_ROOT/ci/scripts/coverage-gate.mjs" contracts
section "slither"
slither . --config-file slither.config.json --fail-high --fail-medium
