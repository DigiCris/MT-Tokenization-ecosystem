#!/usr/bin/env bash
# CI de la app Wallet (trust domain de U) — P16 en adelante.
source "$(dirname "$0")/lib.sh"
ci_node_project frontend/wallet P16
