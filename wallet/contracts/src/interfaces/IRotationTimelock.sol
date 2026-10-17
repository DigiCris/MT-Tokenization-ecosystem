// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {RotationKind} from "../libraries/Roles.sol";

/// @title IRotationTimelock
/// @notice Timelock de 48 h para rotaciones de U/R/S y upgrades del guard ([C-RTL-01..05]).
interface IRotationTimelock {
    enum Status {
        None,
        Pending,
        Cancelled,
        Executed
    }

    struct Proposal {
        address safe;
        RotationKind kind;
        address oldValue;
        address newValue;
        uint64 createdAt;
        uint64 executableAt;
        Status status;
    }

    function GUARD() external view returns (address);
    function DELAY() external view returns (uint256);
    function propose(uint8 kind, address oldValue, address newValue) external returns (bytes32 id);
    function cancel(bytes32 id) external;
    function cancelWithSignature(bytes32 id, bytes calldata signature) external;
    function markExecuted(bytes32 id) external;
    function getProposal(bytes32 id) external view returns (Proposal memory);
    function activeProposal(address safe, RotationKind kind) external view returns (bytes32);
    function executableProposal(address safe, RotationKind kind, address oldValue, address newValue)
        external
        view
        returns (bytes32);
    function cancelDigest(bytes32 id) external view returns (bytes32);
}
