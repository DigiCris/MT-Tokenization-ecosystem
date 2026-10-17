// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @notice Operaciones tipificadas del camino asistido ([C-POL-02], [C-GRD-05..13], [C-GRD-17]).
/// @dev `Unknown` no es una operación permisible: sólo existe para que el modo BOOTSTRAP pueda
///      admitir llamadas no tipificadas durante el desarrollo de contratos; en RESTRICTED siempre se deniega.
enum OpType {
    NoOp,
    Transfer,
    Approve,
    ApproveRevoke,
    Swap,
    WhitelistAdd,
    WhitelistRemove,
    RotationPropose,
    RotationCancel,
    RotationExecute,
    MigrationTransfer,
    GuardUpgrade,
    Unknown
}
