#!/usr/bin/env bash
# Configuración de GitHub para la CI de wallet/ (P02.T04), idempotente:
#   environments  crea los Environments por área y los de release (restringidos a tags wallet-v*)
#   secrets       carga los secretos de CI por Environment desde wallet/.env (nunca los imprime)
#   protection    protección de main (check requerido wallet-ci-gate, PR, commits firmados, admins)
#   rulesets      ruleset que protege los tags wallet-v*
#   verify        lista lo aplicado (nombres de secretos, nunca valores)
#   all           todo lo anterior
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WALLET_ROOT="$(cd "$HERE/../.." && pwd)"
source "$WALLET_ROOT/scripts/env.sh"
REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"

CI_ENVS=(wallet-ci-contracts wallet-ci-backend wallet-ci-signer wallet-ci-frontend-wallet wallet-ci-frontend-recovery wallet-ci-e2e)
RELEASE_ENVS=(wallet-staging wallet-production)
EMAIL=(EMAIL_PROVIDER_API_KEY EMAIL_PROVIDER_DOMAIN EMAIL_PROVIDER_BASE_URL EMAIL_TEST_ADDRESS EMAIL_TEST_GOOGLE_CLIENT_ID EMAIL_TEST_GOOGLE_CLIENT_SECRET EMAIL_TEST_GOOGLE_REFRESH_TOKEN)
DRIVE=(GOOGLE_DRIVE_TEST_CLIENT_ID GOOGLE_DRIVE_TEST_CLIENT_SECRET GOOGLE_DRIVE_TEST_REFRESH_TOKEN)
declare -A SECRETS=(
  [wallet-ci-contracts]="BASE_RPC_URL"
  [wallet-ci-backend]="BASE_RPC_URL ${EMAIL[*]}"
  [wallet-ci-signer]="BASE_RPC_URL"
  [wallet-ci-frontend-wallet]="BASE_RPC_URL ${DRIVE[*]}"
  [wallet-ci-frontend-recovery]="BASE_RPC_URL WALLETCONNECT_PROJECT_ID ${DRIVE[*]}"
  [wallet-ci-e2e]="BASE_RPC_URL WALLETCONNECT_PROJECT_ID ${EMAIL[*]} ${DRIVE[*]}"
)

environments() {
  for env in "${CI_ENVS[@]}"; do
    gh api -X PUT "repos/$REPO/environments/$env" --silent
    echo "environment $env"
  done
  for env in "${RELEASE_ENVS[@]}"; do
    gh api -X PUT "repos/$REPO/environments/$env" --input - --silent <<JSON
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
    if ! gh api "repos/$REPO/environments/$env/deployment-branch-policies" --jq '.branch_policies[] | select(.type == "tag") | .name' | grep -qx 'wallet-v*'; then
      gh api -X POST "repos/$REPO/environments/$env/deployment-branch-policies" -f name='wallet-v*' -f type=tag --silent
    fi
    echo "environment $env (sólo tags wallet-v*)"
  done
}

secrets() {
  for env in "${CI_ENVS[@]}"; do
    for name in ${SECRETS[$env]}; do
      node "$WALLET_ROOT/scripts/lib/env-value.mjs" "$name" | gh secret set "$name" --env "$env" --repo "$REPO" >/dev/null
      echo "secret $env/$name"
    done
  done
}

protection() {
  gh api -X PUT "repos/$REPO/branches/main/protection" --input - --silent <<'JSON'
{
  "required_status_checks": {"strict": false, "checks": [{"context": "wallet-ci-gate"}]},
  "enforce_admins": true,
  "required_pull_request_reviews": {"required_approving_review_count": 0, "require_code_owner_reviews": false, "dismiss_stale_reviews": true},
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
  gh api -X POST "repos/$REPO/branches/main/protection/required_signatures" --silent
  echo "protección de main aplicada"
}

rulesets() {
  local id
  id="$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name == "wallet release tags") | .id')"
  local body
  body='{
    "name": "wallet release tags",
    "target": "tag",
    "enforcement": "active",
    "conditions": {"ref_name": {"include": ["refs/tags/wallet-v*"], "exclude": []}},
    "rules": [{"type": "creation"}, {"type": "update"}, {"type": "deletion"}, {"type": "non_fast_forward"}],
    "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}]
  }'
  if [ -n "$id" ]; then
    gh api -X PUT "repos/$REPO/rulesets/$id" --input - --silent <<<"$body"
  else
    gh api -X POST "repos/$REPO/rulesets" --input - --silent <<<"$body"
  fi
  echo "ruleset de tags wallet-v* aplicado"
}

verify() {
  echo "== environments"
  gh api "repos/$REPO/environments" --jq '.environments[] | .name' | grep '^wallet-' | while read -r env; do
    policies="$(gh api "repos/$REPO/environments/$env" --jq '.deployment_branch_policy // "sin restricción" | tostring')"
    names="$(gh api "repos/$REPO/environments/$env/secrets" --jq '[.secrets[].name] | join(", ")')"
    tags="$(gh api "repos/$REPO/environments/$env/deployment-branch-policies" --jq '[.branch_policies[] | "\(.type):\(.name)"] | join(", ")' 2>/dev/null || true)"
    echo "$env | política: $policies ${tags:+($tags)} | secretos: ${names:-ninguno}"
  done
  echo "== protección de main"
  gh api "repos/$REPO/branches/main/protection" --jq '{checks: [.required_status_checks.checks[].context], enforce_admins: .enforce_admins.enabled, signatures: .required_signatures.enabled, pr_reviews: .required_pull_request_reviews.required_approving_review_count, code_owners: .required_pull_request_reviews.require_code_owner_reviews, force_push: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled}'
  echo "== rulesets"
  gh api "repos/$REPO/rulesets" --jq '.[] | "\(.name) [\(.target), \(.enforcement)]"'
}

case "${1:-}" in
  environments|secrets|protection|rulesets|verify) "$1" ;;
  all) environments; secrets; protection; rulesets; verify ;;
  *) echo "uso: apply-settings.sh environments|secrets|protection|rulesets|verify|all" >&2; exit 2 ;;
esac
