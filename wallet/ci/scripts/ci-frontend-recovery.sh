#!/usr/bin/env bash
# CI de la app Recovery (trust domain de R) — P16 en adelante: design tokens, ABIs, lint (con casos prohibidos),
# typecheck, tests unit, del build de release y del grafo del bundle (wagmi y conectores sólo en el chunk lazy), Drive
# real con la cuenta de prueba, build, tests de navegador (Trusted Types y headers contra `vite preview` y, desde P19,
# enrollment, recuperación de U, rotaciones, emergencia, migración, restauración, modo soberano con la plataforma
# apagada, conectores bajo CSP/TT y WalletConnect por el relay real contra el stack local de scripts/stack/stack.mjs),
# SBOM y la regla de dependencias criptográficas comunes con Wallet ([F-SEC-09]).
source "$(dirname "$0")/lib.sh"
ci_frontend_app frontend/recovery P16
section "dependencias criptográficas comunes con Wallet ([F-SEC-09])"
bash "$CI_SCRIPTS_DIR/check-shared-deps.sh"
