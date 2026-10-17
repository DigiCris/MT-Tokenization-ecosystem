// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {DenyAllModuleGuard} from "../../src/DenyAllModuleGuard.sol";
import {IModuleGuard} from "../../src/interfaces/IModuleGuard.sol";
import {ITransactionGuard} from "../../src/interfaces/ITransactionGuard.sol";
import {Operation} from "../../src/interfaces/ISafe.sol";

/// @notice [C-MGD]: rechaza toda ejecución por módulo y declara ERC-165 con el interfaceId de Safe v1.5.0.
contract DenyAllModuleGuardTest is Test {
    DenyAllModuleGuard internal g;

    function setUp() public {
        g = new DenyAllModuleGuard();
    }

    function testFuzz_checkModuleTransactionAlwaysReverts(
        address to,
        uint256 value,
        bytes memory data,
        bool call,
        address module
    ) public {
        vm.expectRevert(DenyAllModuleGuard.ModuleTransactionsDisabled.selector);
        g.checkModuleTransaction(to, value, data, call ? Operation.Call : Operation.DelegateCall, module);
    }

    function testFuzz_checkAfterModuleExecutionAlwaysReverts(bytes32 h, bool ok) public {
        vm.expectRevert(DenyAllModuleGuard.ModuleTransactionsDisabled.selector);
        g.checkAfterModuleExecution(h, ok);
    }

    function test_supportsInterface() public view {
        assertEq(type(IModuleGuard).interfaceId, bytes4(0x58401ed8));
        assertTrue(g.supportsInterface(0x58401ed8));
        assertTrue(g.supportsInterface(type(IERC165).interfaceId));
        assertFalse(g.supportsInterface(type(ITransactionGuard).interfaceId));
        assertFalse(g.supportsInterface(0xffffffff));
    }

    function test_noState() public view {
        assertEq(address(g).code.length > 0, true);
        // Sin storage: el slot 0 queda vacío tras el deploy.
        assertEq(vm.load(address(g), bytes32(0)), bytes32(0));
    }
}
