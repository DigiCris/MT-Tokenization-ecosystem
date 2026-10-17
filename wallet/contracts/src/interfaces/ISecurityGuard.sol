// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Role} from "../libraries/Roles.sol";

/// @title ISecurityGuard
/// @notice Vistas y registro del `SecurityGuard` ([C-GRD-01], [C-GRD-02], [C-GRD-14]).
interface ISecurityGuard {
    struct SafeRoles {
        address userKey;
        address recoveryKey;
        address executor;
        bool initialized;
        uint64 version;
    }

    function initializeSafe(address userKey, address recoveryKey, address executor) external;
    function updateRoles(address userKey, address recoveryKey, address executor) external;
    function rolesOf(address safe) external view returns (SafeRoles memory);
    function roleOf(address safe, address account) external view returns (Role);
    function isRegistered(address safe) external view returns (bool);
    function evaluateAssisted(address safe, Role role, address to, uint256 value, bytes calldata data)
        external
        view
        returns (bool ok, bytes32 reason);
    function POLICY_REGISTRY() external view returns (address);
    function DESTINATION_WHITELIST() external view returns (address);
    function DENY_ALL_MODULE_GUARD() external view returns (address);
    function WALLET_FACTORY() external view returns (address);
    function SAFE_L2_SINGLETON() external view returns (address);
    function SAFE_PROXY_RUNTIME_CODEHASH() external view returns (bytes32);
    function ROTATION_TIMELOCK() external view returns (address);
    function PERMIT2() external view returns (address);
    function PREDECESSOR() external view returns (address);
}
