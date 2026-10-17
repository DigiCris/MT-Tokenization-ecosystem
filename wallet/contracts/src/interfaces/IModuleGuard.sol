// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Operation} from "./ISafe.sol";

/// @title IModuleGuard
/// @notice Interfaz de guard de módulos de Safe v1.5.0 (interfaceId `0x58401ed8`).
interface IModuleGuard is IERC165 {
    function checkModuleTransaction(address to, uint256 value, bytes memory data, Operation operation, address module)
        external
        returns (bytes32 moduleTxHash);

    function checkAfterModuleExecution(bytes32 txHash, bool success) external;
}
