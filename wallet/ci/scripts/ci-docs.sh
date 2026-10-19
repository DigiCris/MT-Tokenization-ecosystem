#!/usr/bin/env bash
# Documentación y herramientas de wallet/: preflight (tests), docs, wordlist, política de pnpm y claves de release.
source "$(dirname "$0")/lib.sh"
cd "$WALLET_ROOT"
section "tests del preflight"
node --test scripts/preflight.d/__tests__/
section "tests de CI (workflows, gate de cobertura, áreas)"
node --test ci/tests/
section "check-docs"
node scripts/check-docs.mjs
section "contratos externos documentados (EXTERNAL_CONTRACTS.md ↔ base-mainnet.json)"
node scripts/check-external-docs.mjs
section "wordlist MTW-WORDLIST-V1"
node scripts/verify-wordlist.mjs
section "política de supply chain de pnpm"
node scripts/check-pnpm-policy.mjs
section "claves de release (P20.T01: públicas fijadas, ninguna privada versionada ni en el backend)"
node scripts/check-release-keys.mjs
