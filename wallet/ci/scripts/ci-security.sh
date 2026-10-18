#!/usr/bin/env bash
# Escaneos de seguridad de wallet/ (P02.T02): gitleaks sobre la historia completa del branch,
# OSV-Scanner sobre todos los lockfiles, `pnpm audit --prod` por proyecto, Semgrep (reglas de
# TypeScript/JavaScript y Solidity + reglas propias) y zizmor sobre los workflows wallet-*.
# Herramientas por imagen fijada por digest (scripts/tools/versions.json); gitleaks por binario fijado.
source "$(dirname "$0")/lib.sh"
cd "$WALLET_ROOT"

section "gitleaks: historia completa del branch"
gitleaks git --redact --no-banner --exit-code 1 --config "$WALLET_ROOT/.gitleaks.toml" "$REPO_ROOT"

section "OSV-Scanner: lockfiles de wallet/"
mapfile -t lockfiles < <(cd "$WALLET_ROOT" && git ls-files --cached --others --exclude-standard -- '*pnpm-lock.yaml' | sort)
if [ ${#lockfiles[@]} -eq 0 ]; then
  echo "SKIP: no hay lockfiles todavía"
else
  args=()
  for f in "${lockfiles[@]}"; do args+=(--lockfile "/src/$f"); done
  docker_tool osv-scanner -v "$WALLET_ROOT:/src:ro" -- scan source "${args[@]}"
fi

section "pnpm audit --prod por proyecto"
for project in backend/app backend/signer backend/integrity-monitor frontend/wallet frontend/recovery e2e tools/sovereign-exit; do
  if [ -f "$WALLET_ROOT/$project/pnpm-lock.yaml" ]; then
    echo "-- $project"
    (cd "$WALLET_ROOT/$project" && pnpm audit --prod --audit-level low)
  fi
done

# lint-fixtures/ de cada frontend contiene a propósito los patrones prohibidos que ESLint tiene que detectar (P16.T03).
section "Semgrep: TypeScript/JavaScript, Solidity y reglas propias (sin reglas de optimización de gas, docs/security/semgrep-triage.md)"
targets=()
for d in backend frontend e2e tools contracts/src scripts ci; do
  if [ -n "$(cd "$WALLET_ROOT" && git ls-files --cached --others --exclude-standard -- "$d" | grep -E '\.(ts|tsx|js|mjs|cjs|sol)$' | head -1)" ]; then targets+=("/src/$d"); fi
done
if [ ${#targets[@]} -eq 0 ]; then
  echo "SKIP: no hay código fuente todavía"
else
  docker_tool semgrep -v "$WALLET_ROOT:/src:ro" -e SEMGREP_SEND_METRICS=off -- \
    semgrep scan --metrics=off --error --quiet --disable-version-check \
    --exclude node_modules --exclude dist --exclude coverage --exclude dependencies --exclude out \
    --exclude lint-fixtures --exclude test-results --exclude playwright-report \
    --config p/javascript --config p/typescript --config p/nodejs --config p/react --config p/secrets \
    --config p/smart-contracts --config /src/ci/semgrep \
    --exclude-rule solidity.performance.array-length-outside-loop.array-length-outside-loop \
    --exclude-rule solidity.performance.non-payable-constructor.non-payable-constructor \
    --exclude-rule solidity.performance.unnecessary-checked-arithmetic-in-loop.unnecessary-checked-arithmetic-in-loop \
    --exclude-rule solidity.performance.use-nested-if.use-nested-if \
    "${targets[@]}"
fi

section "zizmor: workflows wallet-*"
mapfile -t workflows < <(cd "$REPO_ROOT" && ls .github/workflows/wallet-*.yml 2>/dev/null || true)
if [ ${#workflows[@]} -eq 0 ]; then
  echo "SKIP: no hay workflows wallet-* todavía"
else
  wargs=()
  for f in "${workflows[@]}"; do wargs+=("/repo/$f"); done
  docker_tool zizmor -v "$REPO_ROOT:/repo:ro" -- --offline --min-severity medium "${wargs[@]}"
fi
echo
echo "SECURITY SCANS OK"
