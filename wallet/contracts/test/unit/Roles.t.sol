// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Role, RotationKind, RolesLib, NotAKeyRole} from "../../src/libraries/Roles.sol";

contract RolesHarness {
    function roleOf(RotationKind k) external pure returns (Role) {
        return RolesLib.roleOf(k);
    }

    function kindOf(Role r) external pure returns (RotationKind) {
        return RolesLib.kindOf(r);
    }
}

/// @notice Conversión entre `RotationKind` y `Role` usada por el Guard y el timelock.
contract RolesTest is Test {
    RolesHarness internal h;

    function setUp() public {
        h = new RolesHarness();
    }

    function test_roleOf() public view {
        assertEq(uint8(h.roleOf(RotationKind.User)), uint8(Role.User));
        assertEq(uint8(h.roleOf(RotationKind.Recovery)), uint8(Role.Recovery));
        assertEq(uint8(h.roleOf(RotationKind.Executor)), uint8(Role.Executor));
        assertEq(uint8(h.roleOf(RotationKind.Guard)), uint8(Role.None));
        assertEq(uint8(h.roleOf(RotationKind.ModuleGuard)), uint8(Role.None));
    }

    function test_kindOf() public {
        assertEq(uint8(h.kindOf(Role.User)), uint8(RotationKind.User));
        assertEq(uint8(h.kindOf(Role.Recovery)), uint8(RotationKind.Recovery));
        assertEq(uint8(h.kindOf(Role.Executor)), uint8(RotationKind.Executor));
        vm.expectRevert(NotAKeyRole.selector);
        h.kindOf(Role.None);
    }

    function test_roundTripForKeyRoles() public view {
        for (uint8 r = 1; r <= 3; ++r) {
            assertEq(uint8(h.roleOf(h.kindOf(Role(r)))), r);
        }
    }
}
