#!/usr/bin/env bash
# CI de la app Wallet (trust domain de U) — P16 en adelante: design tokens, lint (con casos prohibidos), typecheck,
# tests unit y del build de release (sin wagmi ni conectores), Drive real con la cuenta de prueba, build, tests de
# navegador (Trusted Types y headers contra `vite preview` y, desde P17, cuenta, onboarding, desbloqueo, Password U,
# restauración y canarios contra el stack local real de scripts/stack/stack.mjs), SBOM, la regla de dependencias
# criptográficas comunes con Recovery ([F-SEC-09]) y la medición de Argon2id en el perfil móvil de referencia (P17.T08).
source "$(dirname "$0")/lib.sh"
ci_frontend_app frontend/wallet P16
section "dependencias criptográficas comunes con Recovery ([F-SEC-09])"
bash "$CI_SCRIPTS_DIR/check-shared-deps.sh"
# CPU 4× con la cuota de Docker dentro de la imagen fijada de Playwright (Chromium y WebKit con sus dependencias). Si la
# cuota no se aplica (Docker rootless sin cgroups), en CI falla y en local lo informa sin medir.
section "frontend/wallet: Argon2id en el perfil móvil de referencia (CPU 4×, Chromium y WebKit)"
(cd "$WALLET_ROOT/frontend/wallet" && pnpm run -s test:browser -- perf/argon2)
