#!/usr/bin/env bash
# SBOM CycloneDX de cada frontend (P16.T07, [F-SEC-06]): syft (imagen fijada por digest en scripts/tools/versions.json)
# sobre el proyecto de la app —su pnpm-lock.yaml y package.json— escribe frontend/<app>/dist/sbom.cdx.json junto al
# build, identificado con el releaseId del manifest. Queda fuera del manifest firmado porque syft le pone fecha y
# número de serie propios. Necesita el build hecho (dist/.well-known/release-manifest.json).
#
# Uso: ci/scripts/sbom.sh [wallet|recovery ...]   (sin argumentos, las dos apps)
source "$(dirname "$0")/lib.sh"
apps=("$@")
[ ${#apps[@]} -gt 0 ] || apps=(wallet recovery)
for app in "${apps[@]}"; do
  dir="$WALLET_ROOT/frontend/$app"
  if [ ! -f "$dir/pnpm-lock.yaml" ]; then
    echo "SKIP: frontend/$app todavía no existe"
    continue
  fi
  manifest="$dir/dist/.well-known/release-manifest.json"
  [ -f "$manifest" ] || { echo "falta el build de frontend/$app (pnpm run build)" >&2; exit 1; }
  release="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).releaseId)" "$manifest")"
  # El SBOM sale por stdout: el contenedor sólo lee el proyecto (montado de sólo lectura) y no escribe en el host.
  docker_tool syft -e SYFT_CHECK_FOR_APP_UPDATE=false -e SYFT_CACHE_DIR=/tmp/syft -v "$dir:/src:ro" -- \
    scan dir:/src --quiet --source-name "mtw-frontend-$app" --source-version "$release" \
    --exclude './node_modules' --exclude './dist' --exclude './coverage' --exclude './test-results' \
    --exclude './playwright-report' \
    -o cyclonedx-json >"$dir/dist/sbom.cdx.json"
  node -e "
    const sbom = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const names = (sbom.components ?? []).map((c) => (c.group ? c.group + '/' : '') + c.name);
    if (sbom.bomFormat !== 'CycloneDX') throw new Error('el SBOM no es CycloneDX');
    for (const required of ['react', 'react-dom', 'viem']) {
      if (!names.includes(required)) throw new Error('el SBOM no lista ' + required);
    }
    console.log('OK: frontend/' + process.argv[2] + '/dist/sbom.cdx.json (CycloneDX ' + sbom.specVersion + ', ' + names.length + ' componentes)');
  " "$dir/dist/sbom.cdx.json" "$app"
done
