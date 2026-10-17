// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @notice Rol de una clave dentro de una Safe del sistema (2-de-3: U, R, S).
/// @dev `None` = la dirección no tiene rol en esa Safe.
enum Role {
    None,
    User,
    Recovery,
    Executor
}

/// @notice Tipo de propuesta del `RotationTimelock` ([C-RTL-02]): rotación de una clave o upgrade del guard.
enum RotationKind {
    User,
    Recovery,
    Executor,
    Guard,
    ModuleGuard
}

/// @notice El rol no corresponde a una clave (U, R o S).
error NotAKeyRole();

/// @title RolesLib
/// @notice Conversión entre `RotationKind` y `Role`.
library RolesLib {
    /// @notice Rol que rota un `RotationKind` de clave; `None` para `Guard`/`ModuleGuard`.
    function roleOf(RotationKind kind) internal pure returns (Role) {
        if (kind == RotationKind.User) return Role.User;
        if (kind == RotationKind.Recovery) return Role.Recovery;
        if (kind == RotationKind.Executor) return Role.Executor;
        return Role.None;
    }

    /// @notice `RotationKind` correspondiente a un rol de clave (revierte con `Role.None`).
    function kindOf(Role role) internal pure returns (RotationKind) {
        if (role == Role.User) return RotationKind.User;
        if (role == Role.Recovery) return RotationKind.Recovery;
        if (role == Role.Executor) return RotationKind.Executor;
        revert NotAKeyRole();
    }
}
