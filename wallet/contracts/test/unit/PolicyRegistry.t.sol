// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PolicyRegistry} from "../../src/PolicyRegistry.sol";
import {PolicyPresets} from "../../script/lib/PolicyPresets.sol";
import {OpType} from "../../src/libraries/OpTypes.sol";
import {Role} from "../../src/libraries/Roles.sol";

/// @notice P04.T04 — [C-POL-01..06]: modos, timelock de 24 h, guardianes, revocación inmediata, sucesores, eventos.
contract PolicyRegistryTest is Test {
    PolicyRegistry internal reg;
    address internal admin = makeAddr("governance");
    address internal g1 = makeAddr("guardian-1");
    address internal g2 = makeAddr("guardian-2");
    address internal stranger = makeAddr("stranger");
    address internal usdc = makeAddr("usdc");
    address internal usdt = makeAddr("usdt");
    address internal executor = makeAddr("executor");

    event ModeRestricted();
    event OpPermissionSet(OpType indexed op, Role indexed role, bool allowed);
    event ChangeProposed(
        bytes32 indexed id,
        PolicyRegistry.ChangeKind indexed kind,
        address subject,
        address target,
        uint256 value,
        uint64 activatesAt
    );
    event ChangeActivated(bytes32 indexed id);
    event ChangeCancelled(bytes32 indexed id, address indexed by);
    event Revoked(
        PolicyRegistry.ChangeKind indexed kind,
        address indexed subject,
        address target,
        uint256 value,
        address indexed by
    );
    event SuccessorGuardSet(address indexed guard, address indexed successor);

    uint256 internal constant T0 = 1_800_000_000;

    function setUp() public {
        vm.warp(T0);
        reg = _deploy(PolicyRegistry.Mode.Restricted);
    }

    function _guardians() internal view returns (address[] memory gs) {
        gs = new address[](2);
        gs[0] = g1;
        gs[1] = g2;
    }

    function _deploy(PolicyRegistry.Mode mode) internal returns (PolicyRegistry) {
        address[] memory executors = new address[](1);
        executors[0] = executor;
        return new PolicyRegistry(
            admin, mode, _guardians(), PolicyPresets.v1Permissions(), PolicyPresets.v1Tokens(usdc, usdt), executors
        );
    }

    // ------------------------------------------------------------------------------------------
    // [C-POL-01] constructor y modos

    function test_constructorRestrictedWithV1() public view {
        assertTrue(reg.isRestricted());
        assertEq(reg.ADMIN(), admin);
        assertEq(reg.ACTIVATION_DELAY(), 24 hours);
        assertTrue(reg.isGuardian(g1) && reg.isGuardian(g2));
        assertTrue(reg.isSupportedToken(usdc) && reg.isSupportedToken(usdt));
        assertEq(reg.tokenDecimals(usdc), 6);
        assertTrue(reg.isSwapExecutor(executor));
    }

    /// [C-POL-04]: exactamente el set V1 por rol.
    function test_v1PermissionSetIsExact() public view {
        bool[13] memory user = [true, true, true, true, true, true, true, true, true, true, true, true, false];
        bool[13] memory recovery = [true, false, false, true, false, false, true, true, true, true, true, false, false];
        for (uint8 i; i <= uint8(type(OpType).max); ++i) {
            assertEq(reg.isOpAllowed(OpType(i), Role.User), user[i], string.concat("U op ", vm.toString(i)));
            assertEq(reg.isOpAllowed(OpType(i), Role.Recovery), recovery[i], string.concat("R op ", vm.toString(i)));
            assertFalse(reg.isOpAllowed(OpType(i), Role.Executor), "S nunca es cofirmante");
        }
    }

    function test_constructorRejectsZeroAdmin() public {
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        new PolicyRegistry(
            address(0),
            PolicyRegistry.Mode.Bootstrap,
            new address[](0),
            new PolicyRegistry.OpPermissionInit[](0),
            new PolicyRegistry.TokenInit[](0),
            new address[](0)
        );
    }

    function test_constructorRejectsInvalidInitialEntries() public {
        PolicyRegistry.OpPermissionInit[] memory bad = new PolicyRegistry.OpPermissionInit[](1);
        bad[0] = PolicyRegistry.OpPermissionInit(OpType.Unknown, Role.User);
        vm.expectRevert(PolicyRegistry.InvalidOpPermission.selector);
        new PolicyRegistry(
            admin,
            PolicyRegistry.Mode.Bootstrap,
            new address[](0),
            bad,
            new PolicyRegistry.TokenInit[](0),
            new address[](0)
        );
        address[] memory dup = new address[](2);
        dup[0] = g1;
        dup[1] = g1;
        vm.expectRevert(PolicyRegistry.AlreadyGuardian.selector);
        new PolicyRegistry(
            admin,
            PolicyRegistry.Mode.Bootstrap,
            dup,
            new PolicyRegistry.OpPermissionInit[](0),
            new PolicyRegistry.TokenInit[](0),
            new address[](0)
        );
    }

    function test_bootstrapAllowsKnownAndUnknownOps() public {
        PolicyRegistry b = _deploy(PolicyRegistry.Mode.Bootstrap);
        assertFalse(b.isRestricted());
        assertTrue(b.isOpAllowed(OpType.GuardUpgrade, Role.Recovery));
        assertTrue(b.isOpAllowed(OpType.Unknown, Role.User));
    }

    function test_restrictedDeniesUnknownAlways() public view {
        assertFalse(reg.isOpAllowed(OpType.Unknown, Role.User));
        assertFalse(reg.isOpAllowed(OpType.Unknown, Role.Recovery));
    }

    /// BOOTSTRAP → RESTRICTED es irreversible y sólo la ejecuta el admin.
    function test_enterRestrictedIsOneWay() public {
        PolicyRegistry b = _deploy(PolicyRegistry.Mode.Bootstrap);
        vm.prank(stranger);
        vm.expectRevert(PolicyRegistry.NotAdmin.selector);
        b.enterRestricted();
        vm.expectEmit(address(b));
        emit ModeRestricted();
        vm.prank(admin);
        b.enterRestricted();
        assertTrue(b.isRestricted());
        vm.prank(admin);
        vm.expectRevert(PolicyRegistry.AlreadyRestricted.selector);
        b.enterRestricted();
        // Ningún setter inmediato vuelve a funcionar.
        vm.prank(admin);
        vm.expectRevert(PolicyRegistry.OnlyInBootstrap.selector);
        b.setOpPermission(OpType.Swap, Role.Recovery, true);
    }

    // ------------------------------------------------------------------------------------------
    // [C-POL-03] BOOTSTRAP: setters inmediatos del admin

    function test_bootstrapSetters() public {
        PolicyRegistry b = _deploy(PolicyRegistry.Mode.Bootstrap);
        address safe1 = makeAddr("safe-1");
        address safe2 = makeAddr("safe-2");
        vm.startPrank(admin);
        b.setOpPermission(OpType.Swap, Role.Recovery, true);
        b.setSupportedToken(makeAddr("dai"), 18, true);
        b.setSwapExecutor(makeAddr("executor-2"), true);
        b.setMigrationAuthorization(safe1, safe2, true);
        b.addGuardian(stranger);
        b.removeGuardian(g2);
        b.setSuccessorGuard(makeAddr("guard"), makeAddr("guard-2"));
        b.setSuccessorModuleGuard(makeAddr("mguard"), makeAddr("mguard-2"));
        vm.stopPrank();
        assertTrue(b.opPermission(OpType.Swap, Role.Recovery));
        assertEq(b.tokenDecimals(makeAddr("dai")), 18);
        assertTrue(b.isSwapExecutor(makeAddr("executor-2")));
        assertTrue(b.isMigrationAuthorized(safe1, safe2));
        assertTrue(b.isGuardian(stranger));
        assertFalse(b.isGuardian(g2));
        assertEq(b.successorGuardOf(makeAddr("guard")), makeAddr("guard-2"));
        assertEq(b.successorModuleGuardOf(makeAddr("mguard")), makeAddr("mguard-2"));
        assertEq(b.guardians().length, 2);
    }

    function test_settersOnlyAdmin() public {
        PolicyRegistry b = _deploy(PolicyRegistry.Mode.Bootstrap);
        vm.startPrank(stranger);
        vm.expectRevert(PolicyRegistry.NotAdmin.selector);
        b.setOpPermission(OpType.Swap, Role.Recovery, true);
        vm.expectRevert(PolicyRegistry.NotAdmin.selector);
        b.addGuardian(stranger);
        vm.expectRevert(PolicyRegistry.NotAdmin.selector);
        b.proposeSwapExecutor(stranger);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------
    // [C-POL-03] RESTRICTED: propuesta → 24 h → activación por cualquiera

    function test_proposeActivateAfterExactly24h() public {
        uint64 activatesAt = uint64(T0 + 24 hours);
        vm.prank(admin);
        bytes32 id = reg.proposeOpPermission(OpType.Swap, Role.Recovery);
        PolicyRegistry.Change memory c = reg.getChange(id);
        assertEq(uint8(c.status), uint8(PolicyRegistry.ChangeStatus.Pending));
        assertEq(c.activatesAt, activatesAt);
        vm.warp(activatesAt - 1);
        vm.expectRevert(PolicyRegistry.ChangeNotMature.selector);
        reg.activateChange(id);
        assertFalse(reg.isOpAllowed(OpType.Swap, Role.Recovery));
        vm.warp(activatesAt);
        vm.expectEmit(address(reg));
        emit ChangeActivated(id);
        vm.prank(stranger);
        reg.activateChange(id);
        assertTrue(reg.isOpAllowed(OpType.Swap, Role.Recovery));
        vm.expectRevert(PolicyRegistry.ChangeNotPending.selector);
        reg.activateChange(id);
    }

    function test_proposalIdsAreUniqueAndEventsEmitted() public {
        vm.recordLogs();
        vm.startPrank(admin);
        bytes32 a = reg.proposeSupportedToken(makeAddr("dai"), 18);
        bytes32 b = reg.proposeSupportedToken(makeAddr("dai"), 18);
        vm.stopPrank();
        assertTrue(a != b);
        assertEq(reg.changeCount(), 2);
        assertEq(vm.getRecordedLogs().length, 2);
    }

    function test_allKindsActivate() public {
        address safe1 = makeAddr("safe-1");
        address safe2 = makeAddr("safe-2");
        address newGuardian = makeAddr("guardian-3");
        address oldGuard = makeAddr("guard");
        address newGuard = makeAddr("guard-2");
        vm.startPrank(admin);
        bytes32[7] memory ids = [
            reg.proposeSupportedToken(makeAddr("dai"), 18),
            reg.proposeSwapExecutor(makeAddr("executor-2")),
            reg.proposeMigrationAuthorization(safe1, safe2),
            reg.proposeGuardianAdd(newGuardian),
            reg.proposeGuardianRemove(g2),
            reg.proposeSuccessorGuard(oldGuard, newGuard),
            reg.proposeSuccessorModuleGuard(oldGuard, newGuard)
        ];
        vm.stopPrank();
        vm.warp(T0 + 24 hours);
        for (uint256 i; i < ids.length; ++i) {
            reg.activateChange(ids[i]);
        }
        assertEq(reg.tokenDecimals(makeAddr("dai")), 18);
        assertTrue(reg.isSwapExecutor(makeAddr("executor-2")));
        assertTrue(reg.isMigrationAuthorized(safe1, safe2));
        assertTrue(reg.isGuardian(newGuardian));
        assertFalse(reg.isGuardian(g2));
        assertEq(reg.successorGuardOf(oldGuard), newGuard);
        assertEq(reg.successorModuleGuardOf(oldGuard), newGuard);
    }

    function test_proposeValidations() public {
        vm.startPrank(admin);
        vm.expectRevert(PolicyRegistry.InvalidOpPermission.selector);
        reg.proposeOpPermission(OpType.Unknown, Role.User);
        vm.expectRevert(PolicyRegistry.InvalidOpPermission.selector);
        reg.proposeOpPermission(OpType.Swap, Role.None);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        reg.proposeSupportedToken(address(0), 6);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        reg.proposeSwapExecutor(address(0));
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        reg.proposeMigrationAuthorization(address(0), stranger);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        reg.proposeGuardianAdd(address(0));
        vm.expectRevert(PolicyRegistry.AlreadyGuardian.selector);
        reg.proposeGuardianAdd(g1);
        vm.expectRevert(PolicyRegistry.NotAGuardian.selector);
        reg.proposeGuardianRemove(stranger);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        reg.proposeSuccessorGuard(address(0), stranger);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        reg.proposeSuccessorModuleGuard(stranger, address(0));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------
    // Cancelaciones

    function test_cancelByAdminOrGuardian() public {
        vm.startPrank(admin);
        bytes32 a = reg.proposeSwapExecutor(makeAddr("x"));
        bytes32 b = reg.proposeSwapExecutor(makeAddr("y"));
        vm.stopPrank();
        vm.expectEmit(address(reg));
        emit ChangeCancelled(a, g1);
        vm.prank(g1);
        reg.cancelChange(a);
        vm.prank(admin);
        reg.cancelChange(b);
        vm.warp(T0 + 24 hours);
        vm.expectRevert(PolicyRegistry.ChangeNotPending.selector);
        reg.activateChange(a);
        vm.prank(stranger);
        vm.expectRevert(PolicyRegistry.NotAdminOrGuardian.selector);
        reg.cancelChange(b);
        vm.prank(g1);
        vm.expectRevert(PolicyRegistry.ChangeNotPending.selector);
        reg.cancelChange(b);
    }

    /// Un guardián no puede cancelar su propia baja; otro guardián sí.
    function test_guardianCannotCancelOwnRemoval() public {
        vm.prank(admin);
        bytes32 id = reg.proposeGuardianRemove(g1);
        vm.prank(g1);
        vm.expectRevert(PolicyRegistry.GuardianCannotCancelOwnRemoval.selector);
        reg.cancelChange(id);
        vm.prank(g2);
        reg.cancelChange(id);
        assertEq(uint8(reg.getChange(id).status), uint8(PolicyRegistry.ChangeStatus.Cancelled));
    }

    function test_cancelAfterMaturityStillPossibleUntilActivated() public {
        vm.prank(admin);
        bytes32 id = reg.proposeSwapExecutor(makeAddr("x"));
        vm.warp(T0 + 30 days);
        vm.prank(g2);
        reg.cancelChange(id);
        vm.expectRevert(PolicyRegistry.ChangeNotPending.selector);
        reg.activateChange(id);
    }

    // ------------------------------------------------------------------------------------------
    // Revocaciones inmediatas (endurecer nunca espera), en ambos modos

    function test_revocationsAreImmediate() public {
        address oldGuard = makeAddr("guard");
        vm.prank(admin);
        bytes32 id = reg.proposeSuccessorGuard(oldGuard, makeAddr("guard-2"));
        vm.prank(admin);
        bytes32 id2 = reg.proposeSuccessorModuleGuard(oldGuard, makeAddr("guard-3"));
        vm.prank(admin);
        bytes32 id3 = reg.proposeMigrationAuthorization(makeAddr("s1"), makeAddr("s2"));
        vm.warp(T0 + 24 hours);
        reg.activateChange(id);
        reg.activateChange(id2);
        reg.activateChange(id3);

        vm.startPrank(g1);
        vm.expectEmit(address(reg));
        emit Revoked(
            PolicyRegistry.ChangeKind.OpPermission,
            address(0),
            address(0),
            (uint256(uint8(OpType.Swap)) << 8) | uint8(Role.User),
            g1
        );
        reg.revokeOpPermission(OpType.Swap, Role.User);
        reg.revokeSupportedToken(usdt);
        reg.revokeSwapExecutor(executor);
        reg.revokeMigrationAuthorization(makeAddr("s1"), makeAddr("s2"));
        vm.expectEmit(address(reg));
        emit SuccessorGuardSet(oldGuard, address(0));
        reg.revokeSuccessorGuard(oldGuard);
        reg.revokeSuccessorModuleGuard(oldGuard);
        vm.stopPrank();

        assertFalse(reg.isOpAllowed(OpType.Swap, Role.User));
        assertFalse(reg.isSupportedToken(usdt));
        assertEq(reg.tokenDecimals(usdt), 6, "los decimales se conservan");
        assertFalse(reg.isSwapExecutor(executor));
        assertFalse(reg.isMigrationAuthorized(makeAddr("s1"), makeAddr("s2")));
        assertEq(reg.successorGuardOf(oldGuard), address(0));
        assertEq(reg.successorModuleGuardOf(oldGuard), address(0));
    }

    function test_revocationsOnlyAdminOrGuardian() public {
        vm.startPrank(stranger);
        vm.expectRevert(PolicyRegistry.NotAdminOrGuardian.selector);
        reg.revokeOpPermission(OpType.Swap, Role.User);
        vm.expectRevert(PolicyRegistry.NotAdminOrGuardian.selector);
        reg.revokeSupportedToken(usdc);
        vm.expectRevert(PolicyRegistry.NotAdminOrGuardian.selector);
        reg.revokeSwapExecutor(executor);
        vm.expectRevert(PolicyRegistry.NotAdminOrGuardian.selector);
        reg.revokeMigrationAuthorization(usdc, usdt);
        vm.expectRevert(PolicyRegistry.NotAdminOrGuardian.selector);
        reg.revokeSuccessorGuard(usdc);
        vm.expectRevert(PolicyRegistry.NotAdminOrGuardian.selector);
        reg.revokeSuccessorModuleGuard(usdc);
        vm.stopPrank();
        // El admin también revoca, y en BOOTSTRAP también es inmediato.
        PolicyRegistry b = _deploy(PolicyRegistry.Mode.Bootstrap);
        vm.prank(admin);
        b.revokeSwapExecutor(executor);
        assertFalse(b.isSwapExecutor(executor));
    }

    function test_removedGuardianLosesPowers() public {
        vm.prank(admin);
        bytes32 id = reg.proposeGuardianRemove(g2);
        vm.warp(T0 + 24 hours);
        reg.activateChange(id);
        vm.prank(g2);
        vm.expectRevert(PolicyRegistry.NotAdminOrGuardian.selector);
        reg.revokeSwapExecutor(executor);
    }

    // ------------------------------------------------------------------------------------------
    // Cada función protegida rechaza a terceros y cada setter inmediato exige BOOTSTRAP

    function _adminCalls() internal view returns (bytes[] memory c) {
        c = new bytes[](17);
        c[0] = abi.encodeCall(PolicyRegistry.setOpPermission, (OpType.Swap, Role.Recovery, true));
        c[1] = abi.encodeCall(PolicyRegistry.setSupportedToken, (usdc, 6, true));
        c[2] = abi.encodeCall(PolicyRegistry.setSwapExecutor, (executor, true));
        c[3] = abi.encodeCall(PolicyRegistry.setMigrationAuthorization, (usdc, usdt, true));
        c[4] = abi.encodeCall(PolicyRegistry.addGuardian, (stranger));
        c[5] = abi.encodeCall(PolicyRegistry.removeGuardian, (g1));
        c[6] = abi.encodeCall(PolicyRegistry.setSuccessorGuard, (usdc, usdt));
        c[7] = abi.encodeCall(PolicyRegistry.setSuccessorModuleGuard, (usdc, usdt));
        c[8] = abi.encodeCall(PolicyRegistry.enterRestricted, ());
        c[9] = abi.encodeCall(PolicyRegistry.proposeOpPermission, (OpType.Swap, Role.Recovery));
        c[10] = abi.encodeCall(PolicyRegistry.proposeSupportedToken, (usdc, 6));
        c[11] = abi.encodeCall(PolicyRegistry.proposeSwapExecutor, (executor));
        c[12] = abi.encodeCall(PolicyRegistry.proposeMigrationAuthorization, (usdc, usdt));
        c[13] = abi.encodeCall(PolicyRegistry.proposeGuardianAdd, (stranger));
        c[14] = abi.encodeCall(PolicyRegistry.proposeGuardianRemove, (g1));
        c[15] = abi.encodeCall(PolicyRegistry.proposeSuccessorGuard, (usdc, usdt));
        c[16] = abi.encodeCall(PolicyRegistry.proposeSuccessorModuleGuard, (usdc, usdt));
    }

    function test_everyAdminFunctionRejectsStrangers() public {
        PolicyRegistry b = _deploy(PolicyRegistry.Mode.Bootstrap);
        bytes[] memory calls = _adminCalls();
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(stranger);
            (bool ok, bytes memory err) = address(b).call(calls[i]);
            assertFalse(ok);
            assertEq(bytes4(err), PolicyRegistry.NotAdmin.selector, vm.toString(i));
            vm.prank(g1);
            (ok, err) = address(b).call(calls[i]);
            assertFalse(ok, "un guardian no es admin");
            assertEq(bytes4(err), PolicyRegistry.NotAdmin.selector);
        }
    }

    function test_everyImmediateSetterRequiresBootstrap() public {
        bytes[] memory calls = _adminCalls();
        for (uint256 i; i < 8; ++i) {
            vm.prank(admin);
            (bool ok, bytes memory err) = address(reg).call(calls[i]);
            assertFalse(ok);
            assertEq(bytes4(err), PolicyRegistry.OnlyInBootstrap.selector, vm.toString(i));
        }
    }

    function test_bootstrapSettersValidate() public {
        PolicyRegistry b = _deploy(PolicyRegistry.Mode.Bootstrap);
        vm.startPrank(admin);
        vm.expectRevert(PolicyRegistry.InvalidOpPermission.selector);
        b.setOpPermission(OpType.Unknown, Role.User, true);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        b.setSupportedToken(address(0), 6, true);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        b.setSwapExecutor(address(0), true);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        b.setMigrationAuthorization(address(0), usdt, true);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        b.addGuardian(address(0));
        vm.expectRevert(PolicyRegistry.AlreadyGuardian.selector);
        b.addGuardian(g1);
        vm.expectRevert(PolicyRegistry.NotAGuardian.selector);
        b.removeGuardian(stranger);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        b.setSuccessorGuard(address(0), usdt);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        b.setSuccessorModuleGuard(address(0), usdt);
        vm.stopPrank();
        vm.prank(g1);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        b.revokeSupportedToken(address(0));
        vm.prank(g1);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        b.revokeSwapExecutor(address(0));
        vm.prank(g1);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        b.revokeMigrationAuthorization(address(0), usdt);
        vm.prank(g1);
        vm.expectRevert(PolicyRegistry.InvalidOpPermission.selector);
        b.revokeOpPermission(OpType.Swap, Role.None);
    }

    /// Dos bajas del mismo guardián pendientes: la segunda activación revierte (ya no es guardián).
    function test_activationRevertsWhenTargetStateChanged() public {
        vm.startPrank(admin);
        bytes32 a = reg.proposeGuardianRemove(g2);
        bytes32 b = reg.proposeGuardianRemove(g2);
        bytes32 c = reg.proposeGuardianAdd(stranger);
        bytes32 d = reg.proposeGuardianAdd(stranger);
        vm.stopPrank();
        vm.warp(T0 + 24 hours);
        reg.activateChange(a);
        vm.expectRevert(PolicyRegistry.NotAGuardian.selector);
        reg.activateChange(b);
        reg.activateChange(c);
        vm.expectRevert(PolicyRegistry.AlreadyGuardian.selector);
        reg.activateChange(d);
    }

    // ------------------------------------------------------------------------------------------
    // Fuzz

    function testFuzz_activationRespectsDelay(uint32 elapsed) public {
        vm.prank(admin);
        bytes32 id = reg.proposeSwapExecutor(makeAddr("x"));
        vm.warp(T0 + uint256(elapsed));
        if (elapsed < 24 hours) {
            vm.expectRevert(PolicyRegistry.ChangeNotMature.selector);
            reg.activateChange(id);
        } else {
            reg.activateChange(id);
            assertTrue(reg.isSwapExecutor(makeAddr("x")));
        }
    }

    function testFuzz_onlyAdminProposes(address caller) public {
        vm.assume(caller != admin);
        vm.prank(caller);
        vm.expectRevert(PolicyRegistry.NotAdmin.selector);
        reg.proposeSwapExecutor(makeAddr("x"));
    }
}
