#!/usr/bin/env bash
# Exporta las ABIs de los contratos del sistema y de las interfaces que usan los consumidores (backend, signer,
# Wallet y Recovery) a out-abi/<Nombre>.json (P07.T06). Cada consumidor las copia a su proyecto en su fase, con un
# chequeo de igualdad en CI. Regenerar no debe producir cambios: bash script/export-abis.sh && git diff --exit-code out-abi
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=../../scripts/env.sh
source ../scripts/env.sh

# Nombres calificados (archivo:contrato): la dependencia de Safe también define un `ISafe`.
contracts=(
  src/SecurityGuard.sol:SecurityGuard
  src/RotationTimelock.sol:RotationTimelock
  src/SafeBootstrap.sol:SafeBootstrap
  src/WalletFactory.sol:WalletFactory
  src/PolicyRegistry.sol:PolicyRegistry
  src/DestinationWhitelist.sol:DestinationWhitelist
  src/DenyAllModuleGuard.sol:DenyAllModuleGuard
  src/SwapExecutorV3.sol:SwapExecutorV3
  src/interfaces/ISafe.sol:ISafe
  src/interfaces/ISafe.sol:ISafeProxyFactory
)
forge build >/dev/null
rm -rf out-abi
mkdir -p out-abi
for qualified in "${contracts[@]}"; do
  name="${qualified##*:}"
  forge inspect "$qualified" abi --json | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      process.stdout.write(JSON.stringify(JSON.parse(s), null, 2) + "\n");
    });
  ' > "out-abi/$name.json"
done
echo "ABIs exportadas: ${#contracts[@]} (out-abi/)"
