// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {PolicyRegistry} from "../../src/PolicyRegistry.sol";
import {OpType} from "../../src/libraries/OpTypes.sol";
import {Role} from "../../src/libraries/Roles.sol";

/// @title PolicyPresets
/// @notice Set V1 de permisos del camino asistido ([C-POL-04]) para staging, producción y el fork local.
library PolicyPresets {
    /// @notice U: NOOP, TRANSFER, APPROVE, APPROVE_REVOKE, SWAP, WHITELIST_ADD, WHITELIST_REMOVE, ROTATION_PROPOSE,
    ///         ROTATION_CANCEL, ROTATION_EXECUTE, MIGRATION_TRANSFER, GUARD_UPGRADE.
    ///         R: NOOP, APPROVE_REVOKE, WHITELIST_REMOVE, ROTATION_PROPOSE, ROTATION_CANCEL, ROTATION_EXECUTE,
    ///         MIGRATION_TRANSFER.
    function v1Permissions() internal pure returns (PolicyRegistry.OpPermissionInit[] memory p) {
        OpType[12] memory userOps = [
            OpType.NoOp,
            OpType.Transfer,
            OpType.Approve,
            OpType.ApproveRevoke,
            OpType.Swap,
            OpType.WhitelistAdd,
            OpType.WhitelistRemove,
            OpType.RotationPropose,
            OpType.RotationCancel,
            OpType.RotationExecute,
            OpType.MigrationTransfer,
            OpType.GuardUpgrade
        ];
        OpType[7] memory recoveryOps = [
            OpType.NoOp,
            OpType.ApproveRevoke,
            OpType.WhitelistRemove,
            OpType.RotationPropose,
            OpType.RotationCancel,
            OpType.RotationExecute,
            OpType.MigrationTransfer
        ];
        p = new PolicyRegistry.OpPermissionInit[](userOps.length + recoveryOps.length);
        for (uint256 i; i < userOps.length; ++i) {
            p[i] = PolicyRegistry.OpPermissionInit(userOps[i], Role.User);
        }
        for (uint256 i; i < recoveryOps.length; ++i) {
            p[userOps.length + i] = PolicyRegistry.OpPermissionInit(recoveryOps[i], Role.Recovery);
        }
    }

    /// @notice USDC y USDT (6 decimales).
    function v1Tokens(address usdc, address usdt) internal pure returns (PolicyRegistry.TokenInit[] memory t) {
        t = new PolicyRegistry.TokenInit[](2);
        t[0] = PolicyRegistry.TokenInit(usdc, 6);
        t[1] = PolicyRegistry.TokenInit(usdt, 6);
    }
}
