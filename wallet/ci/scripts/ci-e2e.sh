#!/usr/bin/env bash
# E2E Playwright y acceptance full-system sobre el fork (P22–P23): wallet/e2e con su runner (un stack local real para
# las dos apps, la matriz de navegadores y la fase de entrega real de email). En GitHub Actions los navegadores se
# instalan con sus dependencias de sistema; en local, Firefox y WebKit corren en la imagen fijada de Playwright.
source "$(dirname "$0")/lib.sh"
skip_if_missing e2e/package.json P22
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  section "e2e: navegadores de Playwright (chromium, firefox, webkit)"
  (cd "$WALLET_ROOT/e2e" && pnpm install --frozen-lockfile && pnpm exec playwright install --with-deps chromium firefox webkit)
fi
ci_node_project e2e P22
