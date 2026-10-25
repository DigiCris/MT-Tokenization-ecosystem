#!/usr/bin/env bash
# DeployCore + VerifyDeployment de punta a punta (P05.T05) sobre un Anvil efímero que forkea el bloque fijado de
# config/chains/base-mainnet.json: red `ci` (deployments/ci.json, gitignored), LOCAL_SEED aleatoria por corrida
# (nunca se imprime) y puerto libre, sin tocar el Anvil del compose ni deployments/local.json.
source "$(dirname "$0")/lib.sh"
: "${FORK_RPC_URL:?falta FORK_RPC_URL (CI: secret BASE_RPC_URL; local: wallet/.env)}"
block="$(node -e 'console.log(require(process.argv[1]).fork.blockNumber)' "$WALLET_ROOT/config/chains/base-mainnet.json")"
# Fallas de red del fork (Anvil copiando estado del RPC de Base, o forge esperando a Anvil): no son del código. Igual
# que scripts/stack/stack.mjs, el deploy se reintenta una sola vez con un Anvil nuevo (misma caché de RPC, ya más
# caliente); cualquier otra falla corta.
TRANSIENT_FORK_ERROR='operation timed out|error sending request|failed to get (account|storage|block)|(^|[^0-9])429([^0-9]|$)|rate limit|connection (reset|refused|closed)'

anvil_pid=""
stop_anvil() {
  if [ -n "$anvil_pid" ]; then
    kill "$anvil_pid" 2>/dev/null || true
    wait "$anvil_pid" 2>/dev/null || true
  fi
  anvil_pid=""
}
trap stop_anvil EXIT

start_anvil() {
  local port
  port="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
  rpc="http://127.0.0.1:$port"
  anvil --host 127.0.0.1 --port "$port" --fork-url "$FORK_RPC_URL" --fork-block-number "$block" --chain-id 8453 \
    --compute-units-per-second 80 --fork-retry-backoff 2000 --retries 30 --timeout 60000 --quiet >/dev/null 2>&1 &
  anvil_pid=$!
  for _ in $(seq 1 120); do
    [ "$(cast chain-id --rpc-url "$rpc" 2>/dev/null || true)" = 8453 ] && return 0
    sleep 1
  done
  echo "el Anvil efímero no respondió con chainId 8453" >&2
  return 1
}

# Corre deploy-core sobre un Anvil nuevo; deja la salida en $1 (la misma que ve el log de CI).
deploy_once() {
  # Dentro del `if !` de abajo no rige `set -e`: cada paso que puede fallar corta explícitamente.
  start_anvil || return 1
  LOCAL_SEED="$(openssl rand -hex 32)"
  export LOCAL_SEED LOCAL_RPC_URL="$rpc" DEPLOYER_KEY_SOURCE=local-seed
  unset GOVERNANCE_SAFE_ADDRESS POLICY_GUARDIANS
  local status=0
  bash "$WALLET_ROOT/scripts/deploy-core" ci 2>&1 | tee "$1" || status=$?
  stop_anvil
  return "$status"
}

output="$(mktemp)"
trap 'stop_anvil; rm -f "$output"' EXIT
if ! deploy_once "$output"; then
  grep -qiE "$TRANSIENT_FORK_ERROR" "$output" || exit 1
  echo "deploy-ephemeral: falla de red del fork; se reintenta una vez con un Anvil nuevo" >&2
  deploy_once "$output"
fi
