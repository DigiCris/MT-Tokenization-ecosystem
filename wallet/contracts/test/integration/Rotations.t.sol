// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {SystemFixture} from "../utils/SystemFixture.sol";
import {SafeOwners} from "../utils/SafeOwners.sol";
import {ISafe} from "../../src/interfaces/ISafe.sol";
import {ISecurityGuard} from "../../src/interfaces/ISecurityGuard.sol";
import {IRotationTimelock} from "../../src/interfaces/IRotationTimelock.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";
import {RotationKind} from "../../src/libraries/Roles.sol";

/// @notice P05.T06 (rotaciones) — [C-GRD-11], [C-GRD-12], A5 y A17: propuesta asistida, 48 h, ejecución con
///         `swapOwner` y cancelación individual por U o R.
contract RotationsTest is SystemFixture {
    using SafeOwners for ISafe;

    uint256 internal t0;
    address internal newKey;
    uint256 internal newKeyPk;

    event RoleRotated(address indexed safe, uint8 indexed role, address oldKey, address newKey);

    function setUp() public {
        _setUpSystem();
        t0 = block.timestamp;
        (newKey, newKeyPk) = makeAddrAndKey("rotated-in-key");
    }

    function _assisted(uint256 cosignerPk, address to, bytes memory data) internal returns (bool) {
        return _exec(safe, executor, _call(to, data), _pair(cosignerPk, executorPk));
    }

    function _deny(uint256 cosignerPk, address to, bytes memory data, bytes4 err) internal {
        _execExpectRevert(safe, executor, _call(to, data), _pair(cosignerPk, executorPk), abi.encodeWithSelector(err));
    }

    function _propose(uint256 cosignerPk, RotationKind kind, address oldV, address newV) internal returns (bytes32 id) {
        assertTrue(
            _assisted(
                cosignerPk,
                address(sys.rotationTimelock),
                abi.encodeCall(IRotationTimelock.propose, (uint8(kind), oldV, newV))
            )
        );
        id = sys.rotationTimelock.activeProposal(address(safe), kind);
        assertTrue(id != bytes32(0));
    }

    function _swapOwner(address oldKey, address newK) internal view returns (bytes memory) {
        return abi.encodeCall(ISafe.swapOwner, (safe.prevOwner(oldKey), oldKey, newK));
    }

    /// U propone rotar S; tras 48 h U+S ejecutan el swapOwner; desde la siguiente tx rige la S nueva.
    function test_userRotatesExecutorAfter48h() public {
        bytes32 id = _propose(userPk, RotationKind.Executor, executor, newKey);
        vm.warp(t0 + 48 hours);
        assertTrue(_assisted(userPk, address(safe), _swapOwner(executor, newKey)));
        ISecurityGuard.SafeRoles memory r = sys.securityGuard.rolesOf(address(safe));
        assertEq(r.executor, newKey);
        assertEq(uint8(sys.rotationTimelock.getProposal(id).status), uint8(IRotationTimelock.Status.Executed));
        assertTrue(safe.isOwner(newKey) && !safe.isOwner(executor));
        // La S nueva opera; la vieja ya no.
        assertTrue(_exec(safe, newKey, _call(address(safe), ""), _pair(userPk, newKeyPk)));
        _execExpectRevert(safe, executor, _call(address(safe), ""), _pair(userPk, executorPk), bytes("GS026"));
    }

    /// A5: R propone y ejecuta el reemplazo de U (recovery asistido).
    function test_recoveryReplacesUserAfter48h() public {
        _propose(recoveryPk, RotationKind.User, userKey, newKey);
        vm.warp(t0 + 48 hours);
        assertTrue(_assisted(recoveryPk, address(safe), _swapOwner(userKey, newKey)));
        assertEq(sys.securityGuard.rolesOf(address(safe)).userKey, newKey);
        assertTrue(_exec(safe, executor, _call(address(safe), ""), _pair(newKeyPk, executorPk)));
    }

    /// A17: antes de 48 h, sin propuesta o con la propuesta cancelada, el swapOwner asistido revierte.
    function test_rotationRequiresMatureUncancelledProposal() public {
        _deny(userPk, address(safe), _swapOwner(executor, newKey), SecurityGuard.RotationNotExecutable.selector);
        bytes32 id = _propose(userPk, RotationKind.Executor, executor, newKey);
        vm.warp(t0 + 48 hours - 1);
        _deny(userPk, address(safe), _swapOwner(executor, newKey), SecurityGuard.RotationNotExecutable.selector);
        // Cancelación individual por firma de R (la transmite un tercero).
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(recoveryPk, sys.rotationTimelock.cancelDigest(id));
        vm.prank(makeAddr("relayer"));
        sys.rotationTimelock.cancelWithSignature(id, abi.encodePacked(rr, ss, v));
        vm.warp(t0 + 72 hours);
        _deny(userPk, address(safe), _swapOwner(executor, newKey), SecurityGuard.RotationNotExecutable.selector);
        // Otra clave distinta de la propuesta tampoco.
        _deny(
            userPk, address(safe), _swapOwner(executor, makeAddr("otra")), SecurityGuard.RotationNotExecutable.selector
        );
    }

    function test_cancelViaAssistedPathAndUserSignature() public {
        bytes32 id = _propose(userPk, RotationKind.User, userKey, newKey);
        assertTrue(_assisted(recoveryPk, address(sys.rotationTimelock), abi.encodeCall(IRotationTimelock.cancel, (id))));
        assertEq(uint8(sys.rotationTimelock.getProposal(id).status), uint8(IRotationTimelock.Status.Cancelled));
        bytes32 id2 = _propose(recoveryPk, RotationKind.User, userKey, newKey);
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(userPk, sys.rotationTimelock.cancelDigest(id2));
        sys.rotationTimelock.cancelWithSignature(id2, abi.encodePacked(rr, ss, v));
        assertEq(uint8(sys.rotationTimelock.getProposal(id2).status), uint8(IRotationTimelock.Status.Cancelled));
    }

    /// [C-GRD-11]: R sólo propone U o S; nunca R ni upgrades de guard.
    function test_recoveryProposalScope() public {
        _deny(
            recoveryPk,
            address(sys.rotationTimelock),
            abi.encodeCall(IRotationTimelock.propose, (uint8(RotationKind.Recovery), recoveryKey, newKey)),
            SecurityGuard.RoleNotAllowed.selector
        );
        _deny(
            recoveryPk,
            address(sys.rotationTimelock),
            abi.encodeCall(IRotationTimelock.propose, (uint8(RotationKind.Guard), address(sys.securityGuard), newKey)),
            SecurityGuard.RoleNotAllowed.selector
        );
        _deny(
            recoveryPk,
            address(sys.rotationTimelock),
            abi.encodeCall(
                IRotationTimelock.propose, (uint8(RotationKind.ModuleGuard), address(sys.denyAllModuleGuard), newKey)
            ),
            SecurityGuard.RoleNotAllowed.selector
        );
        _propose(recoveryPk, RotationKind.Executor, executor, newKey);
    }

    function test_proposalTargetsValidated() public {
        address tl = address(sys.rotationTimelock);
        _deny(
            userPk,
            tl,
            abi.encodeCall(IRotationTimelock.propose, (uint8(5), userKey, newKey)),
            SecurityGuard.InvalidRotationKind.selector
        );
        _deny(
            userPk,
            tl,
            abi.encodeCall(IRotationTimelock.propose, (uint8(RotationKind.User), recoveryKey, newKey)),
            SecurityGuard.RotationOldMismatch.selector
        );
        address[6] memory bad =
            [recoveryKey, executor, address(0), address(1), address(safe), address(sys.policyRegistry)];
        for (uint256 i; i < bad.length; ++i) {
            _deny(
                userPk,
                tl,
                abi.encodeCall(IRotationTimelock.propose, (uint8(RotationKind.User), userKey, bad[i])),
                SecurityGuard.InvalidRotationTarget.selector
            );
        }
        _deny(
            userPk,
            tl,
            abi.encodeCall(IRotationTimelock.propose, (uint8(RotationKind.User), userKey, ext.permit2)),
            SecurityGuard.InvalidRotationTarget.selector
        );
        // swapOwner de una dirección sin rol.
        address stranger = makeAddr("stranger");
        _deny(
            userPk,
            address(safe),
            abi.encodeCall(ISafe.swapOwner, (address(1), stranger, newKey)),
            SecurityGuard.RotationOldMismatch.selector
        );
    }

    /// La ejecución con un `prevOwner` incorrecto la rechaza la propia Safe.
    function test_wrongPrevOwnerRejectedBySafe() public {
        _propose(userPk, RotationKind.Executor, executor, newKey);
        vm.warp(t0 + 48 hours);
        bytes memory data = abi.encodeCall(ISafe.swapOwner, (address(1), executor, newKey));
        _execExpectRevert(safe, executor, _call(address(safe), data), _pair(userPk, executorPk), bytes("GS205"));
    }
}
