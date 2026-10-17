#!/usr/bin/env bash
# Build reproducible de los frontends (P02.T03, P16.T05). Modos:
#   ci-repro-build.sh                      local: dos builds en worktrees limpios y comparación
#   ci-repro-build.sh --single <dir>       un build por app; copia los manifests a <dir> (job de CI)
#   ci-repro-build.sh --compare <d1> <d2>  compara los manifests de dos builds independientes
source "$(dirname "$0")/lib.sh"
APPS=(frontend/wallet frontend/recovery)

app_ready() { # <app>
  [ -f "$WALLET_ROOT/$1/package.json" ] && has_script "$WALLET_ROOT/$1" "build:release"
}

build_into() { # <checkout de wallet/> <app> <destino>
  (cd "$1/$2" && pnpm install --frozen-lockfile && pnpm run -s build:release)
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
  --single)
    out="${2:?falta el directorio de salida}"
    mkdir -p "$out"
    for app in "${APPS[@]}"; do
      if app_ready "$app"; then section "$app: build de release"; build_into "$WALLET_ROOT" "$app" "$out"; fi
    done
    ;;
  --compare)
    compare_dirs "${2:?falta d1}" "${3:?falta d2}"
    ;;
  "")
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    any=0
    for app in "${APPS[@]}"; do app_ready "$app" && any=1; done
    if [ "$any" = 0 ]; then echo "SKIP: frontends con build:release no creados aún (fase P16)"; exit 0; fi
    for n in 1 2; do
      git -C "$REPO_ROOT" worktree add --detach -q "$tmp/wt-$n" HEAD
      # El build reproducible parte del commit actual: los cambios sin commitear no participan.
      for app in "${APPS[@]}"; do
        if app_ready "$app"; then section "$app: build $n"; build_into "$tmp/wt-$n/wallet" "$app" "$tmp/m-$n"; fi
      done
      git -C "$REPO_ROOT" worktree remove --force "$tmp/wt-$n"
    done
    compare_dirs "$tmp/m-1" "$tmp/m-2"
    ;;
  *) echo "uso: ci-repro-build.sh [--single <dir> | --compare <d1> <d2>]" >&2; exit 2 ;;
esac
