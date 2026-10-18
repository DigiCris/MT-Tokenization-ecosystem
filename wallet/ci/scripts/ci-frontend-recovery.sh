#!/usr/bin/env bash
# CI de la app Recovery (trust domain de R) — P16 en adelante: design tokens, lint (con casos prohibidos), typecheck,
# tests unit, del build de release y del grafo del bundle (wagmi y conectores sólo en el chunk lazy), build, tests de
# navegador (Trusted Types y headers contra `vite preview`), SBOM y la regla de dependencias criptográficas comunes con
# Wallet ([F-SEC-09]).
source "$(dirname "$0")/lib.sh"
ci_frontend_app frontend/recovery P16
section "dependencias criptográficas comunes con Wallet ([F-SEC-09])"
bash "$CI_SCRIPTS_DIR/check-shared-deps.sh"
