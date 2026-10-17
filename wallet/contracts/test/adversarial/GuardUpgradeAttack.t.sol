// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {AdversarialBase} from "./AdversarialBase.sol";
import {ISafe} from "../../src/interfaces/ISafe.sol";
import {IRotationTimelock} from "../../src/interfaces/IRotationTimelock.sol";
import {DenyAllModuleGuard} from "../../src/DenyAllModuleGuard.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";
import {RotationKind} from "../../src/libraries/Roles.sol";

/// @notice P07.T01.r — upgrade del Guard ([C-GRD-17], ADR-029): sucesor no registrado, propuesta inmadura o cancelada y
///         `setGuard` hacia un contrato arbitrario revierten en el camino asistido; ni una gobernanza comprometida que
///         registra un sucesor malicioso alcanza para cambiar el Guard si U o R cancelan.
contract GuardUpgradeAttackTest is AdversarialBase {
    SecurityGuard internal successor;
    DenyAllModuleGuard internal evilModuleGuard;

    function setUp() public override {
        super.setUp();
        successor = new SecurityGuard(
            address(sys.policyRegistry),
            address(sys.destinationWhitelist),
            address(sys.denyAllModuleGuard),
            makeAddr("successor-factory"),
            ext.safeL2Singleton,
            ext.proxyRuntimeCodehash,
            ext.permit2,
            address(sys.securityGuard)
        );
        evilModuleGuard = new DenyAllModuleGuard();
    }

    function _registerSuccessor(address guard) internal {
        vm.prank(admin);
        bytes32 id = sys.policyRegistry.proposeSuccessorGuard(address(sys.securityGuard), guard);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        sys.policyRegistry.activateChange(id);
    }

    function _propose(RotationKind kind, address oldV, address newV) internal returns (bytes32) {
        assertTrue(
            _assisted(
                userPk,
                address(sys.rotationTimelock),
                abi.encodeCall(IRotationTimelock.propose, (uint8(kind), oldV, newV))
            )
        );
        return sys.rotationTimelock.activeProposal(address(safe), kind);
    }

    function test_unregisteredSuccessorRejected() public {
        _deny(
            userPk,
            address(safe),
            abi.encodeCall(ISafe.setGuard, (address(successor))),
            SecurityGuard.GuardUpgradeNotAuthorized.selector
        );
        _deny(
            userPk,
            address(sys.rotationTimelock),
            abi.encodeCall(
                IRotationTimelock.propose, (uint8(RotationKind.Guard), address(sys.securityGuard), attacker)
            ),
            SecurityGuard.GuardUpgradeNotAuthorized.selector
        );
        _deny(
            userPk,
            address(safe),
            abi.encodeCall(ISafe.setModuleGuard, (address(evilModuleGuard))),
            SecurityGuard.GuardUpgradeNotAuthorized.selector
        );
        assertEq(_slot(GUARD_SLOT), address(sys.securityGuard));
    }

    function test_immatureOrCancelledProposalRejected() public {
        _registerSuccessor(address(successor));
        bytes32 id = _propose(RotationKind.Guard, address(sys.securityGuard), address(successor));
        uint256 proposedAt = vm.getBlockTimestamp();
        vm.warp(proposedAt + 48 hours - 1);
        _deny(
            userPk,
            address(safe),
            abi.encodeCall(ISafe.setGuard, (address(successor))),
            SecurityGuard.GuardUpgradeNotAuthorized.selector
        );
        bytes memory sig = _ecdsa(recoveryPk, sys.rotationTimelock.cancelDigest(id));
        sys.rotationTimelock.cancelWithSignature(id, sig);
        vm.warp(proposedAt + 30 days);
        _deny(
            userPk,
            address(safe),
            abi.encodeCall(ISafe.setGuard, (address(successor))),
            SecurityGuard.GuardUpgradeNotAuthorized.selector
        );
        assertEq(_slot(GUARD_SLOT), address(sys.securityGuard));
    }

    /// Gobernanza comprometida: registra como sucesor un contrato arbitrario del atacante. Igual hace falta U+S y 48 h
    /// por Safe; U la cancela y el Guard no cambia.
    function test_compromisedGovernanceStillNeedsUserAndDelay() public {
        _registerSuccessor(attacker);
        bytes32 id = _propose(RotationKind.Guard, address(sys.securityGuard), attacker);
        // Sin la firma de U (R+S) no se ejecuta, ni siquiera madura.
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        _deny(
            recoveryPk, address(safe), abi.encodeCall(ISafe.setGuard, (attacker)), SecurityGuard.RoleNotAllowed.selector
        );
        bytes memory sig = _ecdsa(userPk, sys.rotationTimelock.cancelDigest(id));
        sys.rotationTimelock.cancelWithSignature(id, sig);
        _deny(
            userPk,
            address(safe),
            abi.encodeCall(ISafe.setGuard, (attacker)),
            SecurityGuard.GuardUpgradeNotAuthorized.selector
        );
        assertEq(_slot(GUARD_SLOT), address(sys.securityGuard));
    }

    /// Madura la propuesta del sucesor registrado, pero se intenta instalar otro contrato.
    function test_setGuardToDifferentContractRejected() public {
        _registerSuccessor(address(successor));
        _propose(RotationKind.Guard, address(sys.securityGuard), address(successor));
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        _deny(
            userPk,
            address(safe),
            abi.encodeCall(ISafe.setGuard, (attacker)),
            SecurityGuard.GuardUpgradeNotAuthorized.selector
        );
        assertEq(_slot(GUARD_SLOT), address(sys.securityGuard));
    }
}
