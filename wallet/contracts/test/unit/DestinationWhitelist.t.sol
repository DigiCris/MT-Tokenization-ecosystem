// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {DestinationWhitelist} from "../../src/DestinationWhitelist.sol";

/// @notice P04.T05 — [C-WHL-01..03]: altas con activación a las 24 h exactas, bajas inmediatas, aislamiento por Safe.
contract DestinationWhitelistTest is Test {
    DestinationWhitelist internal w;
    address internal safeA = makeAddr("safe-a");
    address internal safeB = makeAddr("safe-b");
    address internal dest = makeAddr("dest");

    event DestinationAdded(address indexed safe, address indexed destination, uint64 activatesAt);
    event DestinationRemoved(address indexed safe, address indexed destination);

    uint256 internal constant T0 = 1_800_000_000;

    function setUp() public {
        w = new DestinationWhitelist();
        vm.warp(T0);
    }

    function test_delayIs24h() public view {
        assertEq(w.ACTIVATION_DELAY(), 24 hours);
    }

    function test_activationExactlyAt24h() public {
        vm.expectEmit(address(w));
        emit DestinationAdded(safeA, dest, uint64(T0 + 24 hours));
        vm.prank(safeA);
        w.addDestination(dest);
        assertFalse(w.isWhitelisted(safeA, dest));
        vm.warp(T0 + 24 hours - 1);
        assertFalse(w.isWhitelisted(safeA, dest));
        (bool exists, uint64 activatesAt, bool active) = w.destinationInfo(safeA, dest);
        assertTrue(exists);
        assertFalse(active);
        vm.warp(T0 + 24 hours);
        assertTrue(w.isWhitelisted(safeA, dest));
        (exists,, active) = w.destinationInfo(safeA, dest);
        assertTrue(active);
        assertEq(activatesAt, T0 + 24 hours);
    }

    function test_isolationBetweenSafes() public {
        vm.prank(safeA);
        w.addDestination(dest);
        vm.warp(T0 + 24 hours);
        assertTrue(w.isWhitelisted(safeA, dest));
        assertFalse(w.isWhitelisted(safeB, dest));
        assertEq(w.destinationsOf(safeB).length, 0);
        // safeB no puede borrar el destino de safeA.
        vm.prank(safeB);
        vm.expectRevert(DestinationWhitelist.NotWhitelisted.selector);
        w.removeDestination(dest);
        assertTrue(w.isWhitelisted(safeA, dest));
    }

    function test_rejectsZeroSelfAndDuplicates() public {
        vm.startPrank(safeA);
        vm.expectRevert(DestinationWhitelist.InvalidDestination.selector);
        w.addDestination(address(0));
        vm.expectRevert(DestinationWhitelist.InvalidDestination.selector);
        w.addDestination(safeA);
        w.addDestination(dest);
        vm.expectRevert(DestinationWhitelist.AlreadyWhitelisted.selector);
        w.addDestination(dest);
        vm.stopPrank();
    }

    function test_removalIsImmediateAndReAddRestartsDelay() public {
        vm.prank(safeA);
        w.addDestination(dest);
        vm.warp(T0 + 2 days);
        assertTrue(w.isWhitelisted(safeA, dest));
        vm.expectEmit(address(w));
        emit DestinationRemoved(safeA, dest);
        vm.prank(safeA);
        w.removeDestination(dest);
        assertFalse(w.isWhitelisted(safeA, dest));
        (bool exists, uint64 activatesAt,) = w.destinationInfo(safeA, dest);
        assertFalse(exists);
        assertEq(activatesAt, 0);
        vm.prank(safeA);
        w.addDestination(dest);
        assertFalse(w.isWhitelisted(safeA, dest));
        vm.warp(T0 + 3 days);
        assertTrue(w.isWhitelisted(safeA, dest));
    }

    function test_destinationsOf() public {
        address d2 = makeAddr("dest-2");
        vm.startPrank(safeA);
        w.addDestination(dest);
        w.addDestination(d2);
        vm.stopPrank();
        address[] memory list = w.destinationsOf(safeA);
        assertEq(list.length, 2);
        assertEq(list[0], dest);
        assertEq(list[1], d2);
    }

    function testFuzz_activation(address safe, address d, uint32 elapsed) public {
        vm.assume(d != address(0) && d != safe);
        vm.prank(safe);
        w.addDestination(d);
        vm.warp(T0 + uint256(elapsed));
        assertEq(w.isWhitelisted(safe, d), elapsed >= 24 hours);
    }
}
