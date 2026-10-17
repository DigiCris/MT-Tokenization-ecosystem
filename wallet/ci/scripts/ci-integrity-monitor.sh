#!/usr/bin/env bash
# CI del integrity monitor (P20).
source "$(dirname "$0")/lib.sh"
ci_node_project backend/integrity-monitor P20
