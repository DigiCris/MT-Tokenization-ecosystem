#!/usr/bin/env bash
# Runner local equivalente a CI (P02.T02, `pnpm ci:local`): corre cada área en orden y termina en
# verde sólo si todas pasan (las áreas todavía no creadas imprimen SKIP).
source "$(dirname "$0")/lib.sh"
areas=(docs contracts backend signer integrity-monitor frontend-wallet frontend-recovery e2e repro-build security)
failed=()
for area in "${areas[@]}"; do
  printf '\n######## ci-%s ########\n' "$area"
  if ! bash "$CI_SCRIPTS_DIR/ci-$area.sh"; then failed+=("$area"); fi
done
echo
if [ ${#failed[@]} -gt 0 ]; then
  echo "CI LOCAL FALLÓ: ${failed[*]}"
  exit 1
fi
echo "CI LOCAL OK"
