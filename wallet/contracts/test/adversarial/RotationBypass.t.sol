// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {AdversarialBase} from "./AdversarialBase.sol";
import {SafeOwners} from "../utils/SafeOwners.sol";
import {ISafe} from "../../src/interfaces/ISafe.sol";
import {IRotationTimelock} from "../../src/interfaces/IRotationTimelock.sol";
import {RotationTimelock} from "../../src/RotationTimelock.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";
import {RotationKind} from "../../src/libraries/Roles.sol";

/// @notice P07.T01.i — bypass de rotación y de timelock (A17): sin propuesta, antes de 48 h, con `old` distinto del rol,
///         con la propuesta cancelada, con otra clave nueva o con R proponiendo su propio rol, el `swapOwner` asistido
///         revierte; el timelock no acepta propuestas, ejecuciones ni cancelaciones de terceros.
contract RotationBypassAttackTest is AdversarialBase {
    using SafeOwners for ISafe;

    function _proposeCall(RotationKind kind, address oldV, address newV) internal pure returns (bytes memory) {
        return abi.encodeCall(IRotationTimelock.propose, (uint8(kind), oldV, newV));
    }

    function _propose(uint256 cosignerPk, RotationKind kind, address oldV, address newV) internal returns (bytes32 id) {
        assertTrue(_assisted(cosignerPk, address(sys.rotationTimelock), _proposeCall(kind, oldV, newV)));
        id = sys.rotationTimelock.activeProposal(address(safe), kind);
        assertTrue(id != bytes32(0));
    }

    function _swapOwner(address oldKey, address newKey) internal view returns (bytes memory) {
        return abi.encodeCall(ISafe.swapOwner, (safe.prevOwner(oldKey), oldKey, newKey));
    }

    function test_rotationWithoutProposalFails() public {
        bytes4 err = SecurityGuard.RotationNotExecutable.selector;
        _deny(userPk, address(safe), _swapOwner(recoveryKey, attacker), err);
        _deny(userPk, address(safe), _swapOwner(executor, attacker), err);
        _deny(recoveryPk, address(safe), _swapOwner(userKey, attacker), err);
        assertTrue(safe.isOwner(recoveryKey) && !safe.isOwner(attacker));
    }

    function test_executionBeforeDelayFails() public {
        uint256 start = vm.getBlockTimestamp();
        _propose(userPk, RotationKind.Recovery, recoveryKey, attacker);
        _deny(userPk, address(safe), _swapOwner(recoveryKey, attacker), SecurityGuard.RotationNotExecutable.selector);
        vm.warp(start + 48 hours - 1);
        _deny(userPk, address(safe), _swapOwner(recoveryKey, attacker), SecurityGuard.RotationNotExecutable.selector);
        assertTrue(safe.isOwner(recoveryKey));
    }

    /// U comprometida + S proponen reemplazar R por una clave del atacante; R cancela con una firma EIP-712 que
    /// transmite cualquiera, y la rotación no se ejecuta nunca.
    function test_recoveryVetoesMaliciousRotation() public {
        bytes32 id = _propose(userPk, RotationKind.Recovery, recoveryKey, attacker);
        bytes memory sig = _ecdsa(recoveryPk, sys.rotationTimelock.cancelDigest(id));
        vm.prank(makeAddr("any-relayer"));
        sys.rotationTimelock.cancelWithSignature(id, sig);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        _deny(userPk, address(safe), _swapOwner(recoveryKey, attacker), SecurityGuard.RotationNotExecutable.selector);
        assertTrue(safe.isOwner(recoveryKey));
    }

    function test_proposalScopeEnforced() public {
        address tl = address(sys.rotationTimelock);
        _deny(
            userPk,
            tl,
            _proposeCall(RotationKind.User, recoveryKey, attacker),
            SecurityGuard.RotationOldMismatch.selector
        );
        _deny(
            recoveryPk,
            tl,
            _proposeCall(RotationKind.Recovery, recoveryKey, attacker),
            SecurityGuard.RoleNotAllowed.selector
        );
        _deny(
            recoveryPk,
            tl,
            _proposeCall(RotationKind.Guard, address(sys.securityGuard), attacker),
            SecurityGuard.RoleNotAllowed.selector
        );
        _deny(
            userPk, tl, _proposeCall(RotationKind.User, userKey, executor), SecurityGuard.InvalidRotationTarget.selector
        );
        _deny(
            userPk,
            tl,
            _proposeCall(RotationKind.Executor, executor, address(safe)),
            SecurityGuard.InvalidRotationTarget.selector
        );
        _deny(
            userPk,
            tl,
            _proposeCall(RotationKind.Executor, executor, address(sys.securityGuard)),
            SecurityGuard.InvalidRotationTarget.selector
        );
    }

    /// Madura la propuesta de una clave legítima, pero se intenta ejecutar con la del atacante.
    function test_executeWithDifferentKeyFails() public {
        _propose(userPk, RotationKind.Executor, executor, makeAddr("legit-new-executor"));
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        _deny(userPk, address(safe), _swapOwner(executor, attacker), SecurityGuard.RotationNotExecutable.selector);
        assertTrue(safe.isOwner(executor) && !safe.isOwner(attacker));
    }

    function test_timelockRejectsThirdParties() public {
        vm.prank(attacker);
        vm.expectRevert(RotationTimelock.NotRegisteredSafe.selector);
        sys.rotationTimelock.propose(uint8(RotationKind.Recovery), recoveryKey, attacker);

        bytes32 id = _propose(userPk, RotationKind.Executor, executor, makeAddr("legit-new-executor"));
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        vm.prank(attacker);
        vm.expectRevert(RotationTimelock.OnlyGuard.selector);
        sys.rotationTimelock.markExecuted(id);
        vm.prank(attacker);
        vm.expectRevert(RotationTimelock.NotProposalSafe.selector);
        sys.rotationTimelock.cancel(id);
        bytes32 digest = sys.rotationTimelock.cancelDigest(id);
        bytes memory attackerSig = _ecdsa(attackerPk, digest);
        vm.expectRevert(RotationTimelock.NotCurrentUserOrRecovery.selector);
        sys.rotationTimelock.cancelWithSignature(id, attackerSig);
        // S es owner pero no veta: sólo la U o la R vigentes.
        bytes memory executorSig = _ecdsa(executorPk, digest);
        vm.expectRevert(RotationTimelock.NotCurrentUserOrRecovery.selector);
        sys.rotationTimelock.cancelWithSignature(id, executorSig);
        assertEq(uint8(sys.rotationTimelock.getProposal(id).status), uint8(IRotationTimelock.Status.Pending));
    }
}
