#!/usr/bin/env bash
# CI del backend (API, worker, watcher, indexer, gas tank) — P08 en adelante.
source "$(dirname "$0")/lib.sh"
ci_node_project backend/app P08
