#!/usr/bin/env bash
# Gate de CI de wallet/ para la protección de main (P02.T04): es el único check requerido y siempre
# reporta. Calcula qué áreas toca el PR (ci/areas.json, mismas rutas que los filtros `paths` de cada
# workflow) y espera a que esos workflows terminen en verde para el mismo commit. Un PR que no toca
# wallet/ pasa enseguida, así los filtros finos por área no bloquean PRs ajenos a wallet/.
set -euo pipefail
: "${BASE_SHA:?falta BASE_SHA}" "${HEAD_SHA:?falta HEAD_SHA}" "${GITHUB_REPOSITORY:?falta GITHUB_REPOSITORY}" "${GH_TOKEN:?falta GH_TOKEN}"
CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMEOUT_SECONDS="${GATE_TIMEOUT_SECONDS:-6000}"

mapfile -t expected < <(git diff --name-only "$BASE_SHA" "$HEAD_SHA" | python3 -I "$CI_DIR/scripts/match-areas.py" "$CI_DIR/areas.json")
if [ ${#expected[@]} -eq 0 ]; then
  echo "El PR no toca áreas de wallet/: nada que esperar."
  exit 0
fi
echo "Workflows esperados para ${HEAD_SHA:0:12}: ${expected[*]}"

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
while :; do
  runs="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs?head_sha=$HEAD_SHA&event=pull_request&per_page=100" \
    --jq '.workflow_runs | sort_by(.run_started_at) | reverse | .[] | [.name, .status, (.conclusion // "")] | @tsv')"
  pending=()
  failed=()
  for wf in "${expected[@]}"; do
    line="$(printf '%s\n' "$runs" | awk -F'\t' -v n="$wf" '$1 == n { print; exit }')"
    if [ -z "$line" ]; then pending+=("$wf (sin run todavía)"); continue; fi
    status="$(printf '%s' "$line" | cut -f2)"
    conclusion="$(printf '%s' "$line" | cut -f3)"
    if [ "$status" != "completed" ]; then pending+=("$wf ($status)"); continue; fi
    case "$conclusion" in
      success|skipped) ;;
      *) failed+=("$wf ($conclusion)") ;;
    esac
  done
  if [ ${#failed[@]} -gt 0 ]; then
    echo "FALLA: ${failed[*]}" >&2
    exit 1
  fi
  if [ ${#pending[@]} -eq 0 ]; then
    echo "Todos los workflows esperados terminaron en verde."
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "TIMEOUT esperando: ${pending[*]}" >&2
    exit 1
  fi
  echo "Esperando: ${pending[*]}"
  sleep 30
done
