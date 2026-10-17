#!/usr/bin/env bash
# Verifica las dependencias Solidity instaladas por Soldeer contra sus fuentes oficiales (P03.T02):
#   forge-std y OpenZeppelin: cada .sol idéntico al del commit del tag oficial (archivo de GitHub por SHA);
#   @uniswap/v3-core: cada .sol idéntico al del tarball de npm (integridad sha512 fijada);
#   safe-smart-account: checkout git exactamente en el commit fijado.
# Las descargas se guardan en wallet/.tools/.cache/deps (no se versionan).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WALLET_ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=../../scripts/lib/common.sh
source "$WALLET_ROOT/scripts/lib/common.sh"
DEPS="$HERE/dependencies"
CACHE="$WALLET_ROOT/.tools/.cache/deps"
mkdir -p "$CACHE"

compare_sol() { # <dir oficial> <dir instalado> <nombre> [subdirectorio oficial excluido]
  local official="$1" installed="$2" name="$3" exclude="${4:-}" f
  local missing=0 differ=0 extra=0
  while IFS= read -r f; do
    if [ ! -f "$installed/$f" ]; then missing=$((missing + 1)); echo "  falta: $f" >&2
    elif ! cmp -s "$official/$f" "$installed/$f"; then differ=$((differ + 1)); echo "  difiere: $f" >&2; fi
  done < <(cd "$official" && find . -name '*.sol' | { if [ -n "$exclude" ]; then grep -v "^./$exclude/"; else cat; fi; } | sort)
  while IFS= read -r f; do
    [ -f "$official/$f" ] || { extra=$((extra + 1)); echo "  extra: $f" >&2; }
  done < <(cd "$installed" && find . -name '*.sol' | sort)
  local total; total="$(cd "$installed" && find . -name '*.sol' | wc -l | tr -d ' ')"
  [ "$missing$differ$extra" = "000" ] || die "$name: $missing faltantes, $differ distintos, $extra extra"
  ok "$name: $total archivos .sol idénticos a la fuente oficial"
}

github_commit() { # <repo> <sha> <subdir oficial> <dir instalado> <nombre> [excluido]
  local repo="$1" sha="$2" sub="$3" installed="$4" name="$5" exclude="${6:-}" tgz x
  tgz="$CACHE/${repo//\//_}-$sha.tar.gz"
  [ -s "$tgz" ] || download "https://codeload.github.com/$repo/tar.gz/$sha" "$tgz"
  x="$(mktemp -d)"
  tar -xzf "$tgz" -C "$x"
  compare_sol "$x/$(basename "$repo")-$sha/$sub" "$installed" "$name" "$exclude"
  rm -rf "$x"
}

github_commit foundry-rs/forge-std f3dae6e6ee381f25eb6a246f7da9b85c91a68219 src "$DEPS/forge-std-1.17.0/src" "forge-std v1.17.0"
# El paquete publicado de OpenZeppelin (y su zip de Soldeer) excluye contracts/mocks/ (sólo para los tests del repo).
github_commit OpenZeppelin/openzeppelin-contracts 5fd1781b1454fd1ef8e722282f86f9293cacf256 contracts \
  "$DEPS/@openzeppelin-contracts-5.6.1" "OpenZeppelin Contracts v5.6.1" mocks

V3_TGZ="$CACHE/uniswap-v3-core-1.0.1.tgz"
[ -s "$V3_TGZ" ] || download "https://registry.npmjs.org/@uniswap/v3-core/-/v3-core-1.0.1.tgz" "$V3_TGZ"
verify_sri_sha512 "$V3_TGZ" "sha512-7pVk4hEm00j9tc71Y9+ssYpO6ytkeI0y7WE9P6UcmNzhxPePwyAxImuhVsTqWK9YFvzgtvzJHi64pBl4jUzKMQ=="
x="$(mktemp -d)"
tar -xzf "$V3_TGZ" -C "$x"
compare_sol "$x/package/contracts" "$DEPS/@uniswap-v3-core-1.0.1/contracts" "@uniswap/v3-core 1.0.1"
rm -rf "$x"

SAFE_REV="dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be"
have="$(git -C "$DEPS/safe-smart-account-1.5.0" rev-parse HEAD)"
[ "$have" = "$SAFE_REV" ] || die "safe-smart-account: commit $have (se esperaba $SAFE_REV)"
git -C "$DEPS/safe-smart-account-1.5.0" diff --quiet HEAD || die "safe-smart-account: el checkout tiene cambios locales"
ok "safe-smart-account v1.5.0: checkout limpio en $SAFE_REV"
echo "DEPENDENCIAS VERIFICADAS"
