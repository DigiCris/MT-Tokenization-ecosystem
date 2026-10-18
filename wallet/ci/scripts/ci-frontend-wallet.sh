#!/usr/bin/env bash
# CI de la app Wallet (trust domain de U) — P16 en adelante: design tokens, lint (con casos prohibidos), typecheck,
# tests unit y del build de release (sin wagmi ni conectores), build, tests de navegador (Trusted Types y headers contra
# `vite preview`), SBOM y la regla de dependencias criptográficas comunes con Recovery ([F-SEC-09]).
source "$(dirname "$0")/lib.sh"
ci_frontend_app frontend/wallet P16
section "dependencias criptográficas comunes con Recovery ([F-SEC-09])"
bash "$CI_SCRIPTS_DIR/check-shared-deps.sh"
