// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Operation} from "./ISafe.sol";

/// @title ITransactionGuard
/// @notice Interfaz de guard de transacciones de Safe v1.5.0 (interfaceId `0xe6d7a83a`).
interface ITransactionGuard is IERC165 {
    /// @notice Llamado por la Safe después de validar las firmas y antes de ejecutar la SafeTx.
    function checkTransaction(
        address to,
        uint256 value,
        bytes memory data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures,
        address msgSender
    ) external;

    /// @notice Llamado por la Safe después de ejecutar la SafeTx.
    function checkAfterExecution(bytes32 hash, bool success) external;
}
