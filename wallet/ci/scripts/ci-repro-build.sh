#!/usr/bin/env bash
# Build reproducible de los frontends (P02.T03, P16.T06). Modos:
#   ci-repro-build.sh                      local (ci:local): por app, dos builds en worktrees limpios de HEAD,
#                                          manifests idénticos y firma verificable (ci/scripts/repro-build.sh)
#   ci-repro-build.sh --inputs <dir>       job de CI previo: insumos del entorno ci (deployment de la red ci y clave
#                                          pública de atestación) para que los dos builds reciban los mismos
#   ci-repro-build.sh --single <dir>       un build por app con los insumos de MTW_FRONTEND_INPUTS; copia los manifests
#                                          a <dir> (job de CI; la firma se prueba en local y en los tests de cada app)
#   ci-repro-build.sh --compare <d1> <d2>  compara los manifests de dos builds independientes
source "$(dirname "$0")/lib.sh"
APPS=(frontend/wallet frontend/recovery)

app_ready() { # <app>
  [ -f "$WALLET_ROOT/$1/package.json" ] && has_script "$WALLET_ROOT/$1" "build:release"
}

build_into() { # <checkout de wallet/> <app> <destino>
  (
    cd "$1/$2"
    pnpm install --frozen-lockfile
    node scripts/sync-design-tokens.mjs
    pnpm exec vite build --logLevel warn
  )
  mkdir -p "$3"
  cp "$1/$2/dist/.well-known/release-manifest.json" "$3/${2//\//-}.json"
}

compare_dirs() { # <d1> <d2>
  local ran=0 f name
  for app in "${APPS[@]}"; do
    name="${app//\//-}.json"
    if [ ! -f "$1/$name" ] && [ ! -f "$2/$name" ]; then continue; fi
    ran=1
    [ -f "$1/$name" ] && [ -f "$2/$name" ] || { echo "FALLA: falta el manifest de $app en uno de los builds" >&2; return 1; }
    if ! cmp -s "$1/$name" "$2/$name"; then
      diff "$1/$name" "$2/$name" || true
      echo "FALLA: $app no es reproducible" >&2
      return 1
    fi
    f="$(sha256sum "$1/$name" | cut -c1-16)"
    echo "OK: $app reproducible (manifest sha256 $f…)"
  done
  [ "$ran" = 1 ] || echo "SKIP: frontends con build:release no creados aún (fase P16)"
}

case "${1:-}" in
  --inputs)
    out="${2:?falta el directorio de salida}"
    unset MTW_FRONTEND_INPUTS
    frontend_ci_inputs
    mkdir -p "$out"
    cp "$MTW_DEPLOYMENT_FILE" "$out/contracts.json"
    printf '%s' "$SIGNER_ATTESTATION_PUBLIC_KEY" >"$out/signer-attestation.pub"
    echo "insumos del entorno ci listos en $out (contratos de la red ci y clave pública de atestación)"
    ;;
  --single)
    out="${2:?falta el directorio de salida}"
    : "${MTW_FRONTEND_INPUTS:?falta MTW_FRONTEND_INPUTS (insumos del job previo)}"
    frontend_ci_inputs
    mkdir -p "$out"
    for app in "${APPS[@]}"; do
      if app_ready "$app"; then section "$app: build de release"; build_into "$WALLET_ROOT" "$app" "$out"; fi
    done
    ;;
  --compare)
    compare_dirs "${2:?falta d1}" "${3:?falta d2}"
    ;;
  "")
    any=0
    for app in "${APPS[@]}"; do
      if app_ready "$app"; then
        any=1
        bash "$CI_SCRIPTS_DIR/repro-build.sh" "${app#frontend/}"
      fi
    done
    [ "$any" = 1 ] || echo "SKIP: frontends con build:release no creados aún (fase P16)"
    ;;
  *) echo "uso: ci-repro-build.sh [--inputs <dir> | --single <dir> | --compare <d1> <d2>]" >&2; exit 2 ;;
esac
