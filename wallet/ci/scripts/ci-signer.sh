#!/usr/bin/env bash
# CI del signer-service (trust domain de S) — P11 en adelante.
source "$(dirname "$0")/lib.sh"
ci_node_project backend/signer P11
