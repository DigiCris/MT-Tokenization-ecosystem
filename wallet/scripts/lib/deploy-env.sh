# shellcheck shell=bash
# Entorno común de los scripts de deploy sobre el fork (deploy-core, deploy-local, seed-local; docs/runbooks/deploy.md).
# Lee de wallet/.env sólo las variables necesarias y las pasa por entorno (nunca por línea de comandos ni a la
# salida). Uso: source scripts/lib/deploy-env.sh && deploy_env <red>  → exporta las variables y deja el RPC en $DEPLOY_RPC.

_deploy_env_value() { node "$WALLET_ROOT/scripts/lib/env-value.mjs" "$1" 2>/dev/null || true; }

# Exporta la variable desde wallet/.env salvo que ya venga en el entorno.
_deploy_env_export() {
  local name="$1" value
  [ -n "${!name:-}" ] && return 0
  value="$(_deploy_env_value "$name")"
  [ -n "$value" ] && export "$name=$value"
  return 0
}

deploy_env() { # <red>
  local network="$1"
  DEPLOY_RPC="${LOCAL_RPC_URL:-$(_deploy_env_value LOCAL_RPC_URL)}"
  if [ -z "$DEPLOY_RPC" ]; then
    echo "falta LOCAL_RPC_URL (wallet/.env)" >&2
    return 1
  fi
  export DEPLOY_NETWORK="$network" DEPLOY_RPC
  local name
  for name in DEPLOYER_KEY_SOURCE GOVERNANCE_SAFE_ADDRESS POLICY_GUARDIANS; do
    _deploy_env_export "$name"
  done
  if [ "$network" = local ] || [ "$network" = ci ]; then
    _deploy_env_export LOCAL_SEED
  else
    # La semilla local nunca participa de un ensayo de staging o producción.
    unset LOCAL_SEED
    if [ -z "${DEPLOYER_ADDRESS:-}" ]; then
      echo "falta DEPLOYER_ADDRESS (dirección del deployer del ensayo, ~/.config/mtw/<env>.env)" >&2
      return 1
    fi
  fi
  DEPLOY_GIT_COMMIT="$(git -C "$WALLET_ROOT" rev-parse HEAD)"
  if [ -n "$(git -C "$WALLET_ROOT" status --porcelain -- contracts config/chains)" ]; then
    DEPLOY_GIT_DIRTY=true
  else
    DEPLOY_GIT_DIRTY=false
  fi
  export DEPLOY_GIT_COMMIT DEPLOY_GIT_DIRTY
}
