#!/usr/bin/env bash
# Build reproducible de un frontend (P16.T06, [F-SEC-06]): dos builds de release consecutivos, cada uno en un worktree
# limpio del commit actual (los cambios sin commitear no participan) y con los mismos insumos del entorno ci (deployment
# de la red ci y la misma clave pública de atestación), tienen que dar el mismo release manifest byte a byte y la misma
# firma Ed25519, verificable con la clave pública de release de la app. Clave: en local, la de desarrollo de wallet/.env
# (`pnpm secrets:local`); en CI, una efímera de la corrida (las de staging y producción viven en el Environment de cada
# pipeline, P20/P26). La clave privada pasa a los builds por un archivo 0600 que se borra al terminar.
#
# Uso: ci/scripts/repro-build.sh <wallet|recovery>
source "$(dirname "$0")/lib.sh"
app="${1:?uso: repro-build.sh <wallet|recovery>}"
case "$app" in wallet | recovery) ;; *) echo "app desconocida: $app" >&2; exit 2 ;; esac
upper="$(echo "$app" | tr '[:lower:]' '[:upper:]')"
frontend_ci_inputs

tmp="$(mktemp -d)"
chmod 700 "$tmp"
cleanup() {
  for n in 1 2; do git -C "$REPO_ROOT" worktree remove --force "$tmp/wt-$n" 2>/dev/null || true; done
  rm -rf "$tmp"
}
trap cleanup EXIT

# Clave de release (nunca se imprime ni pasa por argumentos): la de desarrollo local, por stdin, o una efímera.
key="$tmp/release.key"
pub="$tmp/release.pub"
local_release_key() {
  if [ -z "${GITHUB_ACTIONS:-}" ] && [ -f "$WALLET_ROOT/.env" ]; then
    node "$WALLET_ROOT/scripts/lib/env-value.mjs" "${upper}_RELEASE_SIGNING_KEY_LOCAL" 2>/dev/null || true
  fi
}
origin="$(local_release_key | node -e "
  const { createPrivateKey, createPublicKey, generateKeyPairSync } = require('node:crypto');
  const { readFileSync, writeFileSync } = require('node:fs');
  const [keyFile, pubFile] = process.argv.slice(1);
  const local = readFileSync(0, 'utf8').trim();
  const key = local
    ? createPrivateKey({ key: Buffer.from(local, 'base64'), format: 'der', type: 'pkcs8' })
    : generateKeyPairSync('ed25519').privateKey;
  writeFileSync(keyFile, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(pubFile, createPublicKey(key).export({ type: 'spki', format: 'pem' }));
  process.stdout.write(local ? 'clave de desarrollo local' : 'clave efímera de la corrida');
" "$key" "$pub")"

for n in 1 2; do
  section "frontend/$app: build de release $n (worktree limpio de HEAD)"
  git -C "$REPO_ROOT" worktree add --detach -q "$tmp/wt-$n" HEAD
  appdir="$tmp/wt-$n/wallet/frontend/$app"
  (
    cd "$appdir"
    pnpm install --frozen-lockfile --reporter=silent
    node scripts/sync-design-tokens.mjs
    pnpm exec vite build --logLevel warn
    MTW_RELEASE_KEY_FILE="$key" node build/sign-manifest.ts
    node build/verify-manifest.ts --public-key "$pub"
  )
  cp "$appdir/dist/.well-known/release-manifest.json" "$tmp/manifest-$n.json"
  cp "$appdir/dist/.well-known/release-manifest.json.sig" "$tmp/manifest-$n.sig"
  git -C "$REPO_ROOT" worktree remove --force "$tmp/wt-$n"
done

if ! cmp -s "$tmp/manifest-1.json" "$tmp/manifest-2.json"; then
  diff "$tmp/manifest-1.json" "$tmp/manifest-2.json" || true
  echo "FALLA: frontend/$app no es reproducible (los manifests difieren)" >&2
  exit 1
fi
cmp -s "$tmp/manifest-1.sig" "$tmp/manifest-2.sig" || { echo "FALLA: las firmas difieren" >&2; exit 1; }
release="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).releaseId)" "$tmp/manifest-1.json")"
echo "OK: frontend/$app reproducible ($release, manifest sha256 $(sha256sum "$tmp/manifest-1.json" | cut -c1-16)…) y firma Ed25519 verificable ($origin)"
