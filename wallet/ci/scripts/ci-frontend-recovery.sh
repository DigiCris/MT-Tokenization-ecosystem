#!/usr/bin/env bash
# CI de la app Recovery (trust domain de R) — P16 en adelante.
source "$(dirname "$0")/lib.sh"
ci_node_project frontend/recovery P16
