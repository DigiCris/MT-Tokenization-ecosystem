// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AdversarialBase} from "./AdversarialBase.sol";
import {ISafe} from "../../src/interfaces/ISafe.sol";
import {IRotationTimelock} from "../../src/interfaces/IRotationTimelock.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";
import {SwapExecutorV3} from "../../src/SwapExecutorV3.sol";
import {RotationKind} from "../../src/libraries/Roles.sol";

/// @notice P07.T01.o — migración no autorizada y R+S intentando operar como U+S (A5): sin autorización de migración
///         del registro no hay salida hacia otra Safe; con autorización, el destino tiene que conservar la clave del
///         firmante; R+S no transfiere, no swapea, no amplía la whitelist ni aprueba.
contract UnauthorizedMigrationAttackTest is AdversarialBase {
    ISafe internal target;
    ISafe internal attackerSafe;

    function setUp() public override {
        super.setUp();
        (address s2,) = makeAddrAndKey("um-new-executor");
        target = _createWallet(userKey, recoveryKey, s2, 1);
        (address ar,) = makeAddrAndKey("um-attacker-recovery");
        (address as_,) = makeAddrAndKey("um-attacker-executor");
        attackerSafe = _createWallet(attacker, ar, as_, 2);
    }

    function _authorize(address from, address to) internal {
        vm.prank(admin);
        bytes32 id = sys.policyRegistry.proposeMigrationAuthorization(from, to);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        sys.policyRegistry.activateChange(id);
    }

    function test_migrationWithoutAuthorizationFails() public {
        _deny(userPk, ext.usdc, _transfer(address(target), 1e6), SecurityGuard.DestinationNotWhitelisted.selector);
        _deny(recoveryPk, ext.usdc, _transfer(address(target), 1e6), SecurityGuard.RecoveryCannotTransfer.selector);
        _assertSafeUntouched();
    }

    /// Un admin comprometido autoriza la migración hacia una Safe del atacante: la clave del firmante no coincide en
    /// el destino y la salida revierte.
    function test_authorizationTowardsForeignKeysFails() public {
        _authorize(address(safe), address(attackerSafe));
        assertTrue(sys.policyRegistry.isMigrationAuthorized(address(safe), address(attackerSafe)));
        _deny(userPk, ext.usdc, _transfer(address(attackerSafe), 1e6), SecurityGuard.MigrationRoleMismatch.selector);
        _deny(recoveryPk, ext.usdc, _transfer(address(attackerSafe), 1e6), SecurityGuard.MigrationRoleMismatch.selector);
        // Una dirección cualquiera autorizada (no registrada en el Guard) tampoco.
        _authorize(address(safe), attacker);
        _deny(userPk, ext.usdc, _transfer(attacker, 1e6), SecurityGuard.MigrationRoleMismatch.selector);
        _assertSafeUntouched();
    }

    function test_recoveryAndExecutorCannotOperateAsUser() public {
        address ex = address(sys.swapExecutor);
        _deny(recoveryPk, ext.usdc, _transfer(dest, 1e6), SecurityGuard.RecoveryCannotTransfer.selector);
        _deny(
            recoveryPk,
            ex,
            abi.encodeCall(SwapExecutorV3.swap, (ext.usdc, 10e6, 9.95e6, block.timestamp)),
            SecurityGuard.RoleNotAllowed.selector
        );
        _deny(
            recoveryPk,
            address(sys.destinationWhitelist),
            _addDestination(attacker),
            SecurityGuard.RoleNotAllowed.selector
        );
        _deny(
            recoveryPk,
            ext.usdc,
            abi.encodeCall(IERC20.approve, (ex, 10e6)),
            SecurityGuard.RecoveryCanOnlyRevoke.selector
        );
        _deny(
            recoveryPk,
            address(sys.rotationTimelock),
            abi.encodeCall(IRotationTimelock.propose, (uint8(RotationKind.Recovery), recoveryKey, attacker)),
            SecurityGuard.RoleNotAllowed.selector
        );
        _deny(
            recoveryPk, address(safe), abi.encodeCall(ISafe.setGuard, (attacker)), SecurityGuard.RoleNotAllowed.selector
        );
        _assertSafeUntouched();
    }
}
