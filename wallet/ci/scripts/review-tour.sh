#!/usr/bin/env bash
# Check manual ejecutado por el agente (R-14; workflow wallet-review-tours): instala los navegadores pedidos con sus
# dependencias de sistema y corre, contra el stack local y el fork (scripts/test-browser.mjs), un recorrido de revisión
# (`review/<nombre>`: capturas de cada pantalla en MTW_REVIEW_DIR para el agente revisor) o un simulacro con el stack
# configurado a propósito (`drills/<nombre>`, p. ej. drills/integrity-mismatch con MTW_DRILL=integrity, P20.MAN).
#   APP=wallet|recovery  TOUR=review/<nombre>|drills/<nombre>  MTW_BROWSERS=chromium[,firefox][,webkit]
#   MTW_REVIEW_DIR=<dir>
source "$(dirname "$0")/lib.sh"
[[ "${APP:-}" =~ ^(wallet|recovery)$ ]] || { echo "APP tiene que ser wallet o recovery" >&2; exit 2; }
[[ "${TOUR:-}" =~ ^(review|drills)/[a-z0-9-]+$ ]] || { echo "TOUR inválido (review/<nombre> o drills/<nombre>)" >&2; exit 2; }
[[ "${MTW_BROWSERS:-}" =~ ^(chromium|firefox|webkit)(,(chromium|firefox|webkit))*$ ]] || { echo "MTW_BROWSERS inválido" >&2; exit 2; }
[ -n "${MTW_REVIEW_DIR:-}" ] || { echo "falta MTW_REVIEW_DIR" >&2; exit 2; }
dir="$WALLET_ROOT/frontend/$APP"
[ -f "$dir/test/browser/stack/$TOUR.spec.ts" ] || { echo "no existe $APP/$TOUR" >&2; exit 2; }
# Cada simulacro configura el stack a su manera (scripts/test-browser.mjs): drills/integrity-* → MTW_DRILL=integrity.
case "$TOUR" in
  drills/integrity-*) export MTW_DRILL=integrity ;;
esac
# Insumos del entorno `ci` (contratos de la red ci y clave pública de atestación): los lee la config de build que carga
# también el `vite preview` de la config del stack, igual que en el CI de la app.
frontend_ci_inputs
section "frontend/$APP: pnpm install --frozen-lockfile"
(cd "$dir" && pnpm install --frozen-lockfile)
section "navegadores de Playwright con dependencias: $MTW_BROWSERS"
read -r -a browsers <<< "${MTW_BROWSERS//,/ }"
(cd "$dir" && pnpm exec playwright install --with-deps "${browsers[@]}")
section "$TOUR en $MTW_BROWSERS"
mkdir -p "$MTW_REVIEW_DIR"
(cd "$dir" && pnpm run -s test:browser -- "$TOUR")
