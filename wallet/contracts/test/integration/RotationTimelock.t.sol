// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {SystemFixture} from "../utils/SystemFixture.sol";
import {RotationTimelock} from "../../src/RotationTimelock.sol";
import {IRotationTimelock} from "../../src/interfaces/IRotationTimelock.sol";
import {RotationKind} from "../../src/libraries/Roles.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice P05.T01 — [C-RTL-01..05] con una Safe real registrada en el Guard (las llamadas "de la Safe" se hacen
///         con `vm.prank(safe)`; el flujo completo por SafeTx está en Rotations.t.sol).
contract RotationTimelockTest is SystemFixture {
    RotationTimelock internal tl;
    address internal newKey;
    uint256 internal constant T0 = 1_800_000_000;

    event RotationProposed(
        bytes32 indexed id,
        address indexed safe,
        RotationKind kind,
        address oldValue,
        address newValue,
        uint64 executableAt
    );
    event RotationCancelled(bytes32 indexed id, address indexed safe, address indexed by);
    event RotationExecuted(bytes32 indexed id, address indexed safe);

    function setUp() public {
        _setUpSystem();
        tl = sys.rotationTimelock;
        newKey = makeAddr("new-key");
        vm.warp(T0);
    }

    function _propose(uint8 kind, address oldV, address newV) internal returns (bytes32 id) {
        vm.prank(address(safe));
        id = tl.propose(kind, oldV, newV);
    }

    function test_constantsAndDomain() public view {
        assertEq(tl.DELAY(), 48 hours);
        assertEq(tl.GUARD(), address(sys.securityGuard));
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("MTW RotationTimelock"),
                keccak256("1"),
                block.chainid,
                address(tl)
            )
        );
        assertEq(tl.domainSeparator(), expected);
        assertEq(tl.CANCEL_ROTATION_TYPEHASH(), keccak256("CancelRotation(bytes32 proposalId,address safe)"));
    }

    function test_proposeStoresAndDerivesId() public {
        bytes32 expectedId = keccak256(
            abi.encode(block.chainid, address(tl), address(safe), RotationKind.Executor, executor, newKey, uint256(1))
        );
        vm.expectEmit(address(tl));
        emit RotationProposed(expectedId, address(safe), RotationKind.Executor, executor, newKey, uint64(T0 + 48 hours));
        bytes32 id = _propose(uint8(RotationKind.Executor), executor, newKey);
        assertEq(id, expectedId);
        IRotationTimelock.Proposal memory p = tl.getProposal(id);
        assertEq(p.safe, address(safe));
        assertEq(uint8(p.kind), uint8(RotationKind.Executor));
        assertEq(p.oldValue, executor);
        assertEq(p.newValue, newKey);
        assertEq(p.createdAt, T0);
        assertEq(p.executableAt, T0 + 48 hours);
        assertEq(uint8(p.status), uint8(IRotationTimelock.Status.Pending));
        assertEq(tl.activeProposal(address(safe), RotationKind.Executor), id);
        assertEq(tl.executableProposal(address(safe), RotationKind.Executor, executor, newKey), bytes32(0));
        vm.warp(T0 + 48 hours - 1);
        assertEq(tl.executableProposal(address(safe), RotationKind.Executor, executor, newKey), bytes32(0));
        vm.warp(T0 + 48 hours);
        assertEq(tl.executableProposal(address(safe), RotationKind.Executor, executor, newKey), id);
        assertEq(tl.executableProposal(address(safe), RotationKind.Executor, executor, makeAddr("otra")), bytes32(0));
    }

    function test_proposeValidations() public {
        vm.prank(makeAddr("no-safe"));
        vm.expectRevert(RotationTimelock.NotRegisteredSafe.selector);
        tl.propose(0, userKey, newKey);

        vm.startPrank(address(safe));
        vm.expectRevert(RotationTimelock.InvalidKind.selector);
        tl.propose(5, userKey, newKey);
        vm.expectRevert(RotationTimelock.InvalidNewValue.selector);
        tl.propose(uint8(RotationKind.User), userKey, address(0));
        vm.expectRevert(RotationTimelock.InvalidNewValue.selector);
        tl.propose(uint8(RotationKind.User), userKey, userKey);
        vm.expectRevert(RotationTimelock.OldValueMismatch.selector);
        tl.propose(uint8(RotationKind.User), recoveryKey, newKey);
        vm.expectRevert(RotationTimelock.InvalidNewValue.selector);
        tl.propose(uint8(RotationKind.User), userKey, executor);
        vm.expectRevert(RotationTimelock.InvalidNewValue.selector);
        tl.propose(uint8(RotationKind.User), userKey, address(safe));
        // Guard/ModuleGuard: old == slot actual y sucesor registrado.
        vm.expectRevert(RotationTimelock.OldValueMismatch.selector);
        tl.propose(uint8(RotationKind.Guard), makeAddr("otro"), newKey);
        vm.expectRevert(RotationTimelock.SuccessorNotRegistered.selector);
        tl.propose(uint8(RotationKind.Guard), address(sys.securityGuard), newKey);
        vm.expectRevert(RotationTimelock.SuccessorNotRegistered.selector);
        tl.propose(uint8(RotationKind.ModuleGuard), address(sys.denyAllModuleGuard), newKey);
        // A lo sumo una activa por (safe, kind).
        tl.propose(uint8(RotationKind.User), userKey, newKey);
        vm.expectRevert(RotationTimelock.ActiveProposalExists.selector);
        tl.propose(uint8(RotationKind.User), userKey, makeAddr("otra"));
        vm.stopPrank();
    }

    function test_cancelBySafeOnly() public {
        bytes32 id = _propose(uint8(RotationKind.User), userKey, newKey);
        vm.prank(makeAddr("otro"));
        vm.expectRevert(RotationTimelock.NotProposalSafe.selector);
        tl.cancel(id);
        vm.expectEmit(address(tl));
        emit RotationCancelled(id, address(safe), address(safe));
        vm.prank(address(safe));
        tl.cancel(id);
        assertEq(uint8(tl.getProposal(id).status), uint8(IRotationTimelock.Status.Cancelled));
        assertEq(tl.activeProposal(address(safe), RotationKind.User), bytes32(0));
        vm.prank(address(safe));
        vm.expectRevert(RotationTimelock.NotPending.selector);
        tl.cancel(id);
        // Tras cancelar se puede proponer de nuevo.
        _propose(uint8(RotationKind.User), userKey, newKey);
    }

    function _cancelSig(uint256 pk, bytes32 id) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, tl.cancelDigest(id));
        return abi.encodePacked(r, s, v);
    }

    /// [C-RTL-03]: U o R vigentes cancelan con firma EIP-712, la transmite cualquiera, antes o después de madurar.
    function test_cancelWithSignatureByUserAndRecovery() public {
        bytes32 a = _propose(uint8(RotationKind.Executor), executor, newKey);
        vm.warp(T0 + 3 days); // ya madura: igual se puede cancelar
        vm.expectEmit(address(tl));
        emit RotationCancelled(a, address(safe), userKey);
        vm.prank(makeAddr("relayer"));
        tl.cancelWithSignature(a, _cancelSig(userPk, a));
        assertEq(uint8(tl.getProposal(a).status), uint8(IRotationTimelock.Status.Cancelled));

        bytes32 b = _propose(uint8(RotationKind.User), userKey, newKey);
        tl.cancelWithSignature(b, _cancelSig(recoveryPk, b));
        assertEq(uint8(tl.getProposal(b).status), uint8(IRotationTimelock.Status.Cancelled));
    }

    function test_cancelWithSignatureRejectsOthers() public {
        bytes32 id = _propose(uint8(RotationKind.User), userKey, newKey);
        // Las firmas se calculan antes de cada expectRevert (cancelDigest es otra llamada).
        bytes memory byExecutor = _cancelSig(executorPk, id);
        (, uint256 strangerPk) = makeAddrAndKey("stranger");
        bytes memory byStranger = _cancelSig(strangerPk, id);
        vm.expectRevert(RotationTimelock.NotCurrentUserOrRecovery.selector);
        tl.cancelWithSignature(id, byExecutor);
        vm.expectRevert(RotationTimelock.NotCurrentUserOrRecovery.selector);
        tl.cancelWithSignature(id, byStranger);
        // Firma maleable (s alto) y largo distinto de 65 bytes: rechazadas por ECDSA.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, tl.cancelDigest(id));
        bytes32 highS =
            bytes32(uint256(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141) - uint256(s));
        bytes memory malleable = abi.encodePacked(r, highS, v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        tl.cancelWithSignature(id, malleable);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, uint256(64)));
        tl.cancelWithSignature(id, abi.encodePacked(r, s));
        // Una vez cancelada, ninguna firma la reactiva ni la vuelve a cancelar.
        bytes memory byUser = _cancelSig(userPk, id);
        vm.prank(address(safe));
        tl.cancel(id);
        vm.expectRevert(RotationTimelock.NotPending.selector);
        tl.cancelWithSignature(id, byUser);
    }

    function test_markExecutedOnlyGuardAfterMaturity() public {
        bytes32 id = _propose(uint8(RotationKind.User), userKey, newKey);
        vm.expectRevert(RotationTimelock.OnlyGuard.selector);
        tl.markExecuted(id);
        vm.prank(address(sys.securityGuard));
        vm.expectRevert(RotationTimelock.NotMature.selector);
        tl.markExecuted(id);
        vm.warp(T0 + 48 hours);
        vm.expectEmit(address(tl));
        emit RotationExecuted(id, address(safe));
        vm.prank(address(sys.securityGuard));
        tl.markExecuted(id);
        assertEq(uint8(tl.getProposal(id).status), uint8(IRotationTimelock.Status.Executed));
        assertEq(tl.activeProposal(address(safe), RotationKind.User), bytes32(0));
        vm.prank(address(sys.securityGuard));
        vm.expectRevert(RotationTimelock.NotPending.selector);
        tl.markExecuted(id);
    }

    function test_idsAreUniquePerSafeCounter() public {
        bytes32 a = _propose(uint8(RotationKind.User), userKey, newKey);
        vm.prank(address(safe));
        tl.cancel(a);
        bytes32 b = _propose(uint8(RotationKind.User), userKey, newKey);
        assertTrue(a != b);
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(RotationTimelock.ZeroAddress.selector);
        new RotationTimelock(address(0));
    }
}
