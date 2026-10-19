#!/usr/bin/env bash
# CI de la herramienta de salida soberana (P19.T09): install congelado, lint, typecheck, tests (cripto y SafeTx contra
# los vectores de contracts/, dos builds idénticos con su CSP por hashes y la firma del release), build y el E2E: el HTML
# abierto desde el disco hace una transferencia soberana U + R en el fork con la plataforma apagada.
source "$(dirname "$0")/lib.sh"
ci_node_project tools/sovereign-exit P19
section "tools/sovereign-exit: navegador de Playwright (headless shell de la versión fijada)"
ensure_playwright_browser "$WALLET_ROOT/tools/sovereign-exit"
section "tools/sovereign-exit: E2E en el fork con la plataforma apagada"
(cd "$WALLET_ROOT/tools/sovereign-exit" && pnpm run -s test:e2e)
