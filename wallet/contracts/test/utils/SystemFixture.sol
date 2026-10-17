// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {ForkTest} from "./ForkTest.sol";
import {SafeHelpers} from "./SafeHelpers.sol";
import {SystemDeployer} from "../../script/lib/SystemDeployer.sol";
import {PolicyRegistry} from "../../src/PolicyRegistry.sol";
import {ISafe} from "../../src/interfaces/ISafe.sol";

/// @notice Sistema completo desplegado sobre el fork (mismo código que `DeployCore`) y una Safe real creada por la
///         `WalletFactory` con claves nuevas U, R y S (nunca cuentas públicas de Anvil, algunas delegadas por
///         EIP-7702 en Base).
abstract contract SystemFixture is ForkTest, SafeHelpers {
    SystemDeployer.Deployment internal sys;

    address internal admin;
    address internal guardian1;
    address internal guardian2;

    address internal userKey;
    uint256 internal userPk;
    address internal recoveryKey;
    uint256 internal recoveryPk;
    address internal executor;
    uint256 internal executorPk;

    ISafe internal safe;

    function _keys() internal {
        admin = makeAddr("mtw-governance-safe");
        guardian1 = makeAddr("mtw-guardian-1");
        guardian2 = makeAddr("mtw-guardian-2");
        (userKey, userPk) = makeAddrAndKey("mtw-user-key");
        (recoveryKey, recoveryPk) = makeAddrAndKey("mtw-recovery-key");
        (executor, executorPk) = makeAddrAndKey("mtw-executor-key");
    }

    function _deploySystem(PolicyRegistry.Mode mode, bool v1Policy) internal {
        address[] memory guardians = new address[](2);
        guardians[0] = guardian1;
        guardians[1] = guardian2;
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 6);
        sys = SystemDeployer.deploy(ext, SystemDeployer.Params(admin, mode, guardians, v1Policy, address(0)), predicted);
    }

    function _createWallet(address u, address r, address s, uint256 saltNonce) internal returns (ISafe) {
        return ISafe(sys.walletFactory.createWallet(u, r, s, saltNonce));
    }

    /// @notice Fork + sistema RESTRICTED con el set V1 (igual que producción) + Safe de U, R, S.
    function _setUpSystem() internal {
        _setUpSystem(PolicyRegistry.Mode.Restricted);
    }

    /// @notice Modo de policy de las suites adversarial e invariantes (P07.T09): `POLICY_MODE=restricted` (por
    ///         defecto, igual que producción) o `POLICY_MODE=bootstrap`.
    function _policyMode() internal view returns (PolicyRegistry.Mode) {
        bytes32 mode = keccak256(bytes(vm.envOr("POLICY_MODE", string("restricted"))));
        if (mode == keccak256("bootstrap")) return PolicyRegistry.Mode.Bootstrap;
        require(mode == keccak256("restricted"), "POLICY_MODE: restricted | bootstrap");
        return PolicyRegistry.Mode.Restricted;
    }

    function _setUpSystem(PolicyRegistry.Mode mode) internal {
        _fork();
        _keys();
        _deploySystem(mode, true);
        safe = _createWallet(userKey, recoveryKey, executor, 0);
    }

    /// @notice Saldo real de USDC/USDT del fork (escritura del storage del token con `deal`).
    function _fund(address token, address to, uint256 amount) internal {
        deal(token, to, amount);
    }
}
