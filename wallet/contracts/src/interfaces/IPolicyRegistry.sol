// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {OpType} from "../libraries/OpTypes.sol";
import {Role} from "../libraries/Roles.sol";

/// @title IPolicyRegistry
/// @notice Vistas del `PolicyRegistry` que consultan el Guard y el `RotationTimelock` ([C-POL-01..06]).
interface IPolicyRegistry {
    function ADMIN() external view returns (address);
    function isRestricted() external view returns (bool);
    /// @notice En BOOTSTRAP: true para toda operación tipificada; en RESTRICTED: según el registro de permisos.
    function isOpAllowed(OpType op, Role role) external view returns (bool);
    function isSupportedToken(address token) external view returns (bool);
    function tokenDecimals(address token) external view returns (uint8);
    function isSwapExecutor(address executor) external view returns (bool);
    function isMigrationAuthorized(address oldSafe, address newSafe) external view returns (bool);
    function isGuardian(address account) external view returns (bool);
    /// @notice Sucesor activo de un Guard ([C-POL-06]); `address(0)` si no hay.
    function successorGuardOf(address guard) external view returns (address);
    /// @notice Sucesor activo de un module guard ([C-POL-06]); `address(0)` si no hay.
    function successorModuleGuardOf(address moduleGuard) external view returns (address);
}
