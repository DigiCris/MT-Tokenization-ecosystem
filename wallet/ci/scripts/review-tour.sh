#!/usr/bin/env bash
# Recorrido de revisión de un check manual (R-14; workflow wallet-review-tours): instala los navegadores pedidos con sus
# dependencias de sistema y corre test/browser/stack/review/<TOUR>.spec.ts de la app contra el stack local y el fork
# (scripts/test-browser.mjs). Las capturas de cada pantalla quedan en MTW_REVIEW_DIR para el agente revisor.
#   APP=wallet|recovery  TOUR=<spec sin .spec.ts>  MTW_BROWSERS=chromium[,firefox][,webkit]  MTW_REVIEW_DIR=<dir>
source "$(dirname "$0")/lib.sh"
[[ "${APP:-}" =~ ^(wallet|recovery)$ ]] || { echo "APP tiene que ser wallet o recovery" >&2; exit 2; }
[[ "${TOUR:-}" =~ ^[a-z0-9-]+$ ]] || { echo "TOUR inválido" >&2; exit 2; }
[[ "${MTW_BROWSERS:-}" =~ ^(chromium|firefox|webkit)(,(chromium|firefox|webkit))*$ ]] || { echo "MTW_BROWSERS inválido" >&2; exit 2; }
[ -n "${MTW_REVIEW_DIR:-}" ] || { echo "falta MTW_REVIEW_DIR" >&2; exit 2; }
dir="$WALLET_ROOT/frontend/$APP"
[ -f "$dir/test/browser/stack/review/$TOUR.spec.ts" ] || { echo "no existe el recorrido $APP/$TOUR" >&2; exit 2; }
section "frontend/$APP: pnpm install --frozen-lockfile"
(cd "$dir" && pnpm install --frozen-lockfile)
section "navegadores de Playwright con dependencias: $MTW_BROWSERS"
read -r -a browsers <<< "${MTW_BROWSERS//,/ }"
(cd "$dir" && pnpm exec playwright install --with-deps "${browsers[@]}")
section "recorrido review/$TOUR en $MTW_BROWSERS"
mkdir -p "$MTW_REVIEW_DIR"
(cd "$dir" && pnpm run -s test:browser -- "review/$TOUR")
