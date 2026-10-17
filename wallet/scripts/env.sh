# shellcheck shell=bash
# Uso: source scripts/env.sh (desde wallet/ o desde cualquier script del proyecto).
# Antepone la toolchain local fijada (wallet/.tools, ADR-032) al PATH. No lee ni exporta secretos.
WALLET_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export WALLET_ROOT
export WALLET_TOOLS="$WALLET_ROOT/.tools"
for _mtw_dir in slither-bin age/bin gitleaks/bin foundry/bin pnpm/bin node/bin; do
  case ":$PATH:" in
    *":$WALLET_TOOLS/$_mtw_dir:"*) ;;
    *) PATH="$WALLET_TOOLS/$_mtw_dir:$PATH" ;;
  esac
done
unset _mtw_dir
export PATH
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
