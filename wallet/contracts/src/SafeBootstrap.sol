// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {ISafe} from "./interfaces/ISafe.sol";
import {ISecurityGuard} from "./interfaces/ISecurityGuard.sol";

/// @title SafeBootstrap
/// @notice Configuración atómica de cada Safe nueva durante `Safe.setup` ([C-BST-01..02]).
/// @dev La Safe lo ejecuta por DELEGATECALL desde `setupModules(to, data)`: instala el `SecurityGuard` y el
///      `DenyAllModuleGuard` y registra los roles en el Guard. Sin estado; llamado directamente revierte.
contract SafeBootstrap {
    /// @notice `SecurityGuard` que se instala y en el que se registran los roles.
    address public immutable SECURITY_GUARD;
    /// @notice Module guard que se instala.
    address public immutable DENY_ALL_MODULE_GUARD;
    /// @notice Dirección propia, para detectar llamadas que no son DELEGATECALL.
    address public immutable SELF;

    /// @notice `bootstrap` se llamó directamente y no por DELEGATECALL desde una Safe.
    error OnlyDelegateCall();
    /// @notice Dirección cero en el constructor.
    error ZeroAddress();

    constructor(address securityGuard, address denyAllModuleGuard) {
        if (securityGuard == address(0) || denyAllModuleGuard == address(0)) revert ZeroAddress();
        SECURITY_GUARD = securityGuard;
        DENY_ALL_MODULE_GUARD = denyAllModuleGuard;
        SELF = address(this);
    }

    /// @notice Instala guard y module guard en la Safe que ejecuta el DELEGATECALL y registra sus roles.
    /// @param userKey Clave U.
    /// @param recoveryKey Clave R.
    /// @param executor Clave S.
    function bootstrap(address userKey, address recoveryKey, address executor) external {
        if (address(this) == SELF) revert OnlyDelegateCall();
        ISafe(address(this)).setGuard(SECURITY_GUARD);
        ISafe(address(this)).setModuleGuard(DENY_ALL_MODULE_GUARD);
        ISecurityGuard(SECURITY_GUARD).initializeSafe(userKey, recoveryKey, executor);
    }
}
