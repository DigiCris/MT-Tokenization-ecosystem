#!/usr/bin/env bash
# CI del signer-service (trust domain de S) — P11 en adelante. Los tests de integración usan Docker (Testcontainers:
# PostgreSQL 18 fijado por digest), Anvil sobre el fork de Base (BASE_RPC_URL) con el sistema instalado por los
# scripts del repo (Foundry y las dependencias de contracts/) y `age` de la toolchain (backups y custodia).
source "$(dirname "$0")/lib.sh"
skip_if_missing backend/signer/package.json P11
section "backend/signer: vectores y ABIs iguales a los de contracts/ (§10, regla 2)"
node "$WALLET_ROOT/backend/signer/scripts/sync-contract-artifacts.mjs" --check
section "contracts: dependencias (soldeer) para instalar el sistema en el fork de los tests"
(cd "$WALLET_ROOT/contracts" && { [ -d dependencies ] || forge soldeer install; })
ci_node_project backend/signer P11
section "backend/signer: spec OpenAPI interna al día (openapi.json, nunca publicada)"
(cd "$WALLET_ROOT/backend/signer" && pnpm run -s check:openapi)
