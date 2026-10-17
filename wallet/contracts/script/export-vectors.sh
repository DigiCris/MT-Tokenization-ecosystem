#!/usr/bin/env bash
# Regenera los vectores cruzados de test/vectors/*.json, test/vectors/wire/*.json (P07.T05, §7.15) y
# test/vectors/policy/policy.json (P11.T03) con la Safe real del fork en el bloque fijado (test/fork/Vectors.t.sol con
# EXPORT_VECTORS=true) y node:crypto (script/wire-vectors.mjs, script/policy-vectors.mjs). Regenerar no debe producir
# cambios:
#   bash script/export-vectors.sh && git diff --exit-code test/vectors
# Sin EXPORT_VECTORS, el mismo test exige que los archivos commiteados coincidan con el código.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=../../scripts/env.sh
source ../scripts/env.sh
if [ -z "${FORK_RPC_URL:-}" ] && [ -f ../.env ]; then
  FORK_RPC_URL="$(node ../scripts/lib/env-value.mjs BASE_RPC_URL 2>/dev/null || true)"
  export FORK_RPC_URL
fi
mkdir -p test/vectors/wire
EXPORT_VECTORS=true forge test --match-contract VectorsTest
# [W-02]..[W-07]: formatos no EVM, con node:crypto (usa system.json y safe-tx.json recién escritos).
node script/wire-vectors.mjs
# [B-POL]: casos de decisión de policy (usan system.json recién escrito).
node script/policy-vectors.mjs
echo "vectores regenerados en test/vectors/"
