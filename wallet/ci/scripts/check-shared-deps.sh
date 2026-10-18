#!/usr/bin/env bash
# Regla de dependencias criptográficas comunes entre Wallet y Recovery ([F-SEC-09], P16.T10): ningún upgrade del mismo
# paquete @noble/*, @scure/* o viem en las dos apps con menos de 72 h entre ambos (ci/scripts/check-shared-deps.mjs).
# Necesita la historia de git (en CI, checkout con fetch-depth: 0).
source "$(dirname "$0")/lib.sh"
if [ "$(git -C "$REPO_ROOT" rev-parse --is-shallow-repository)" = true ]; then
  echo "check-shared-deps necesita la historia completa (checkout con fetch-depth: 0)" >&2
  exit 1
fi
node "$CI_SCRIPTS_DIR/check-shared-deps.mjs" --root "$REPO_ROOT" "$@"
