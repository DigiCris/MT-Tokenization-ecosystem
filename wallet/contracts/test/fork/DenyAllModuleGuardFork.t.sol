// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {ForkTest} from "../utils/ForkTest.sol";
import {SafeHelpers} from "../utils/SafeHelpers.sol";
import {ISafe, Operation} from "../../src/interfaces/ISafe.sol";
import {DenyAllModuleGuard} from "../../src/DenyAllModuleGuard.sol";

interface IModuleManagerFull {
    function enableModule(address module) external;
    function execTransactionFromModule(address to, uint256 value, bytes memory data, Operation operation)
        external
        returns (bool success);
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes memory data, Operation operation)
        external
        returns (bool success, bytes memory returnData);
}

/// @notice P04.T06: Safe 1.5.0 acepta `setModuleGuard(DenyAll)` (ERC-165) y desde entonces toda ejecución por módulo
///         revierte, aun con un módulo habilitado por los owners.
contract DenyAllModuleGuardForkTest is ForkTest, SafeHelpers {
    DenyAllModuleGuard internal denyAll;
    ISafe internal safe;
    uint256 internal pkA;
    uint256 internal pkB;
    address internal module = makeAddr("module");

    bytes32 internal constant MODULE_GUARD_SLOT = 0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;

    function setUp() public {
        _fork();
        denyAll = new DenyAllModuleGuard();
        address[] memory owners = new address[](2);
        (owners[0], pkA) = makeAddrAndKey("dam-owner-a");
        (owners[1], pkB) = makeAddrAndKey("dam-owner-b");
        safe = _deployPlainSafe(ext.safeProxyFactory, ext.safeL2Singleton, owners, 2, 7);
    }

    function test_setModuleGuardAcceptedAndModuleTxsRevert() public {
        assertTrue(
            _exec(
                safe,
                address(this),
                _call(address(safe), abi.encodeCall(ISafe.setModuleGuard, (address(denyAll)))),
                _pair(pkA, pkB)
            )
        );
        assertEq(address(uint160(uint256(bytes32(safe.getStorageAt(uint256(MODULE_GUARD_SLOT), 1))))), address(denyAll));

        // Los owners habilitan un módulo: igual no puede ejecutar nada.
        assertTrue(
            _exec(
                safe,
                address(this),
                _call(address(safe), abi.encodeCall(IModuleManagerFull.enableModule, (module))),
                _pair(pkA, pkB)
            )
        );
        vm.deal(address(safe), 1 ether);
        vm.startPrank(module);
        vm.expectRevert(DenyAllModuleGuard.ModuleTransactionsDisabled.selector);
        IModuleManagerFull(address(safe)).execTransactionFromModule(module, 1 ether, "", Operation.Call);
        vm.expectRevert(DenyAllModuleGuard.ModuleTransactionsDisabled.selector);
        IModuleManagerFull(address(safe)).execTransactionFromModuleReturnData(module, 0, "", Operation.DelegateCall);
        vm.stopPrank();
        assertEq(address(safe).balance, 1 ether);
    }

    /// Un contrato sin ERC-165 de IModuleGuard es rechazado por la Safe (GS301): DenyAll declara la interfaz correcta.
    function test_safeRejectsModuleGuardWithoutErc165() public {
        bytes memory data = abi.encodeCall(ISafe.setModuleGuard, (address(this)));
        bytes memory sigs = _sigs(_txHash(safe, _call(address(safe), data), safe.nonce()), _pair(pkA, pkB));
        vm.expectRevert(bytes(""));
        _execRaw(safe, address(this), _call(address(safe), data), sigs);
    }
}
