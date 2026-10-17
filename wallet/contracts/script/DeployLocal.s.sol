// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {console} from "forge-std/Script.sol";
import {DeployCore} from "./DeployCore.s.sol";
import {VerifyDeployment} from "./VerifyDeployment.s.sol";
import {DeploymentJson} from "./lib/DeploymentJson.sol";
import {SystemDeployer} from "./lib/SystemDeployer.sol";

/// @title DeployLocal
/// @notice Deploy del sistema en el fork local ([C-SCR-03], P07.T07), idempotente: si `deployments/local.json`
///         describe un deploy que verifica contra el estado actual del fork, no transmite nada; si no (fork recién
///         reseteado o JSON de otro estado), despliega con `DeployCore` en la red `local`. Con el fork recién reseteado
///         el deployer tiene nonce 0, así que las direcciones son siempre las mismas.
/// @dev Uso: `pnpm deploy-local [--policy-mode restricted|bootstrap]` (`scripts/deploy-local`).
contract DeployLocal is DeployCore {
    /// @notice Ya hay un deploy verificado con otro modo de policy: hace falta `pnpm fork:reset` para cambiarlo.
    error DifferentPolicyModeDeployed(string deployed, string requested);

    /// @notice Verifica el deploy existente o despliega uno nuevo en `local`.
    function run() public override returns (SystemDeployer.Deployment memory d) {
        vm.setEnv("DEPLOY_NETWORK", "local");
        string memory path = DeploymentJson.path("local");
        if (vm.exists(path)) {
            string memory json = vm.readFile(path);
            VerifyDeployment verifier = new VerifyDeployment();
            if (verifier.verifyQuietly(json) == 0) {
                string memory deployed = vm.parseJsonString(json, ".policy.mode");
                string memory requested = _requestedMode();
                if (!DeploymentJson.eq(deployed, requested)) revert DifferentPolicyModeDeployed(deployed, requested);
                console.log("deploy local existente y verificado: no se transmite nada");
                console.log("WalletFactory:", vm.parseJsonAddress(json, ".contracts.WalletFactory.address"));
                return d;
            }
            console.log("deployments/local.json no corresponde al estado del fork: se despliega de nuevo");
        }
        return super.run();
    }

    function _requestedMode() internal view returns (string memory) {
        return
            DeploymentJson.eq(vm.envOr("POLICY_MODE", string("restricted")), "bootstrap") ? "Bootstrap" : "Restricted";
    }
}
