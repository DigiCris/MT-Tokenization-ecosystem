// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {AdversarialBase, ISafeAdmin} from "./AdversarialBase.sol";
import {SafeOwners} from "../utils/SafeOwners.sol";
import {ISafe, Operation} from "../../src/interfaces/ISafe.sol";
import {ISecurityGuard} from "../../src/interfaces/ISecurityGuard.sol";
import {PolicyRegistry} from "../../src/PolicyRegistry.sol";
import {RotationTimelock} from "../../src/RotationTimelock.sol";
import {SafeBootstrap} from "../../src/SafeBootstrap.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";
import {WalletFactory} from "../../src/WalletFactory.sol";
import {OpType} from "../../src/libraries/OpTypes.sol";
import {Role} from "../../src/libraries/Roles.sol";

/// @notice P07.T01.n — cambios administrativos por el camino asistido ([C-GRD-13]): owners, threshold, guard, module
///         guard, módulos, fallback, `approveHash`, `execTransaction` anidado, `setup` y llamadas a los contratos del
///         sistema revierten para U+S y R+S.
contract AdminCallsAttackTest is AdversarialBase {
    using SafeOwners for ISafe;

    function _nestedExec() internal view returns (bytes memory) {
        return abi.encodeCall(
            ISafe.execTransaction,
            (ext.usdc, 0, _transfer(attacker, 1e6), Operation.Call, 0, 0, 0, address(0), payable(address(0)), "")
        );
    }

    function test_safeAdminCallsForbidden() public {
        bytes[9] memory calls = [
            abi.encodeCall(ISafeAdmin.addOwnerWithThreshold, (attacker, 1)),
            abi.encodeCall(ISafeAdmin.removeOwner, (safe.prevOwner(recoveryKey), recoveryKey, 1)),
            abi.encodeCall(ISafeAdmin.changeThreshold, (1)),
            abi.encodeCall(ISafeAdmin.enableModule, (attacker)),
            abi.encodeCall(ISafeAdmin.disableModule, (address(0x1), attacker)),
            abi.encodeCall(ISafeAdmin.setFallbackHandler, (attacker)),
            abi.encodeCall(ISafeAdmin.approveHash, (bytes32(uint256(1)))),
            abi.encodeWithSignature("simulateAndRevert(address,bytes)", attacker, ""),
            _nestedExec()
        ];
        for (uint256 i; i < calls.length; ++i) {
            _deny(userPk, address(safe), calls[i], SecurityGuard.AdminCallForbidden.selector);
            _deny(recoveryPk, address(safe), calls[i], SecurityGuard.AdminCallForbidden.selector);
        }
        assertEq(safe.getThreshold(), 2);
        assertEq(safe.getOwners().length, 3);
    }

    /// `setGuard`/`setModuleGuard` sólo como GUARD_UPGRADE autorizado ([C-GRD-17]): sin sucesor, revierten.
    function test_guardAndModuleGuardChangesForbidden() public {
        address[2] memory targets = [address(0), attacker];
        for (uint256 i; i < 2; ++i) {
            _deny(
                userPk,
                address(safe),
                abi.encodeCall(ISafe.setGuard, (targets[i])),
                SecurityGuard.GuardUpgradeNotAuthorized.selector
            );
            _deny(
                userPk,
                address(safe),
                abi.encodeCall(ISafe.setModuleGuard, (targets[i])),
                SecurityGuard.GuardUpgradeNotAuthorized.selector
            );
            _deny(
                recoveryPk,
                address(safe),
                abi.encodeCall(ISafe.setGuard, (targets[i])),
                SecurityGuard.RoleNotAllowed.selector
            );
        }
        assertEq(_slot(GUARD_SLOT), address(sys.securityGuard));
        assertEq(_slot(MODULE_GUARD_SLOT), address(sys.denyAllModuleGuard));
    }

    function test_systemContractCallsForbidden() public {
        bytes4 err = SecurityGuard.AdminCallForbidden.selector;
        _deny(
            userPk,
            address(sys.securityGuard),
            abi.encodeCall(ISecurityGuard.updateRoles, (attacker, recoveryKey, executor)),
            err
        );
        _deny(
            userPk,
            address(sys.policyRegistry),
            abi.encodeCall(PolicyRegistry.setOpPermission, (OpType.Transfer, Role.Recovery, true)),
            err
        );
        _deny(userPk, address(sys.denyAllModuleGuard), abi.encodeWithSignature("supportsInterface(bytes4)", 0), err);
        _deny(
            userPk,
            address(sys.walletFactory),
            abi.encodeCall(WalletFactory.createWallet, (attacker, recoveryKey, executor, 1)),
            err
        );
        _deny(
            userPk,
            address(sys.safeBootstrap),
            abi.encodeCall(SafeBootstrap.bootstrap, (attacker, recoveryKey, executor)),
            err
        );
        _deny(userPk, address(sys.rotationTimelock), abi.encodeCall(RotationTimelock.markExecuted, (bytes32(0))), err);
        _deny(
            userPk,
            address(sys.destinationWhitelist),
            abi.encodeWithSignature("destinationsOf(address)", address(safe)),
            err
        );
        _assertSafeUntouched();
    }
}
