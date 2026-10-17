// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Script, console} from "forge-std/Script.sol";
import {DeploymentJson} from "./lib/DeploymentJson.sol";
import {LocalKeys} from "./lib/LocalKeys.sol";

/// @title FundForkAccounts
/// @notice Fondea en Anvil (`anvil_setBalance`) las cuentas que transmiten `DeployCore`: en `local` y `ci`, el deployer y
///         el creador de la Governance Safe derivados de `LOCAL_SEED`; en `fork/*`, `DEPLOYER_ADDRESS`.
/// @dev Corre en una invocación de forge anterior a `DeployCore`, porque la simulación on-chain de `forge script`
///      usa el estado del bloque en que arrancó. Revierte fuera de Anvil.
contract FundForkAccounts is Script {
    /// @notice Saldo del deployer en el fork.
    uint256 internal constant DEPLOYER_FUNDING = 100 ether;
    /// @notice Saldo del creador de la Governance Safe local.
    uint256 internal constant CREATOR_FUNDING = 1 ether;

    /// @notice Fondea las cuentas de `DEPLOY_NETWORK`.
    function run() external {
        if (DeploymentJson.isSeedNetwork(DeploymentJson.network())) {
            _fund(LocalKeys.addr("deployer"), DEPLOYER_FUNDING);
            _fund(LocalKeys.addr("governance-owner-1"), CREATOR_FUNDING);
        } else {
            _fund(vm.envAddress("DEPLOYER_ADDRESS"), DEPLOYER_FUNDING);
        }
    }

    function _fund(address account, uint256 amount) private {
        LocalKeys.fund(account, amount);
        console.log("cuenta fondeada en el fork:", account);
    }
}
