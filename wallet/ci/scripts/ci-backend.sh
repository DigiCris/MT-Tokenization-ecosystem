#!/usr/bin/env bash
# CI del backend (API, worker, watcher, indexer, gas tank) — P08 en adelante. Los tests de integración usan Docker
# (Testcontainers: PostgreSQL 18 y Valkey 9 fijados por digest) y Anvil sobre el fork de Base (BASE_RPC_URL).
source "$(dirname "$0")/lib.sh"
skip_if_missing backend/app/package.json P08
section "backend/app: vectores y ABIs iguales a los de contracts/ (§10, regla 2)"
node "$WALLET_ROOT/backend/app/scripts/sync-contract-artifacts.mjs" --check
ci_node_project backend/app P08
