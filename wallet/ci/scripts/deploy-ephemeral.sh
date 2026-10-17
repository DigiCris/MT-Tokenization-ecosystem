#!/usr/bin/env bash
# DeployCore + VerifyDeployment de punta a punta (P05.T05) sobre un Anvil efímero que forkea el bloque fijado de
# config/chains/base-mainnet.json: red `ci` (deployments/ci.json, gitignored), LOCAL_SEED aleatoria por corrida
# (nunca se imprime) y puerto libre, sin tocar el Anvil del compose ni deployments/local.json.
source "$(dirname "$0")/lib.sh"
: "${FORK_RPC_URL:?falta FORK_RPC_URL (CI: secret BASE_RPC_URL; local: wallet/.env)}"
block="$(node -e 'console.log(require(process.argv[1]).fork.blockNumber)' "$WALLET_ROOT/config/chains/base-mainnet.json")"
port="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
rpc="http://127.0.0.1:$port"

anvil --host 127.0.0.1 --port "$port" --fork-url "$FORK_RPC_URL" --fork-block-number "$block" --chain-id 8453 \
  --fork-retry-backoff 1000 --retries 10 --timeout 60000 --quiet >/dev/null 2>&1 &
anvil_pid=$!
cleanup() {
  kill "$anvil_pid" 2>/dev/null || true
  wait "$anvil_pid" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 120); do
  [ "$(cast chain-id --rpc-url "$rpc" 2>/dev/null || true)" = 8453 ] && break
  sleep 1
done
if [ "$(cast chain-id --rpc-url "$rpc" 2>/dev/null || true)" != 8453 ]; then
  echo "el Anvil efímero no respondió con chainId 8453" >&2
  exit 1
fi

LOCAL_SEED="$(openssl rand -hex 32)"
export LOCAL_SEED LOCAL_RPC_URL="$rpc" DEPLOYER_KEY_SOURCE=local-seed
unset GOVERNANCE_SAFE_ADDRESS POLICY_GUARDIANS
bash "$WALLET_ROOT/scripts/deploy-core" ci
