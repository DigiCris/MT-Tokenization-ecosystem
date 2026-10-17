// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IModuleGuard} from "./interfaces/IModuleGuard.sol";
import {Operation} from "./interfaces/ISafe.sol";

/// @title DenyAllModuleGuard
/// @notice Module guard de Safe v1.5.0 que rechaza toda ejecución por módulos ([C-MGD]).
/// @dev Sin estado ni owner. Con este module guard instalado, aun si U+R habilitaran un módulo por camino
///      soberano, ninguna `execTransactionFromModule` puede ejecutarse mientras siga configurado.
contract DenyAllModuleGuard is IModuleGuard {
    /// @notice Las transacciones por módulo están deshabilitadas en las Safes del sistema.
    error ModuleTransactionsDisabled();

    /// @inheritdoc IModuleGuard
    function checkModuleTransaction(address, uint256, bytes memory, Operation, address)
        external
        pure
        returns (bytes32)
    {
        revert ModuleTransactionsDisabled();
    }

    /// @inheritdoc IModuleGuard
    function checkAfterModuleExecution(bytes32, bool) external pure {
        revert ModuleTransactionsDisabled();
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IModuleGuard).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
