// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IRotationTimelock} from "./interfaces/IRotationTimelock.sol";
import {ISecurityGuard} from "./interfaces/ISecurityGuard.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";
import {ISafe} from "./interfaces/ISafe.sol";
import {RotationKind, Role, RolesLib} from "./libraries/Roles.sol";

/// @title RotationTimelock
/// @notice Timelock de 48 h para rotaciones asistidas de U, R o S y para upgrades del Guard / module guard
///         ([C-RTL-01..05], ADR-007, ADR-029). Lo despliega el `SecurityGuard` en su constructor.
/// @dev Una Safe registrada propone (SafeTx asistida U+S o R+S validada por el Guard, o por camino soberano);
///      la U o la R **vigentes** pueden cancelar individualmente con una firma EIP-712 que transmite cualquiera
///      (`cancelWithSignature`), aun después de madurar y hasta que se ejecute; la ejecución la marca el Guard
///      al validar el `swapOwner` / `setGuard` correspondiente ([C-GRD-12], [C-GRD-17]).
contract RotationTimelock is IRotationTimelock, EIP712 {
    using RolesLib for RotationKind;

    /// @notice Tipo EIP-712 de la cancelación individual.
    bytes32 public constant CANCEL_ROTATION_TYPEHASH = keccak256("CancelRotation(bytes32 proposalId,address safe)");
    /// @inheritdoc IRotationTimelock
    uint256 public constant DELAY = 48 hours;

    bytes32 private constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 private constant MODULE_GUARD_STORAGE_SLOT =
        0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;

    /// @inheritdoc IRotationTimelock
    address public immutable GUARD;

    mapping(bytes32 id => Proposal) private _proposals;
    mapping(address safe => mapping(RotationKind kind => bytes32 id)) private _active;
    mapping(address safe => uint256) private _count;

    event RotationProposed(
        bytes32 indexed id,
        address indexed safe,
        RotationKind kind,
        address oldValue,
        address newValue,
        uint64 executableAt
    );
    event RotationCancelled(bytes32 indexed id, address indexed safe, address indexed by);
    event RotationExecuted(bytes32 indexed id, address indexed safe);

    error NotRegisteredSafe();
    error InvalidKind();
    error ActiveProposalExists();
    error OldValueMismatch();
    error InvalidNewValue();
    error SuccessorNotRegistered();
    error NotPending();
    error NotProposalSafe();
    error NotCurrentUserOrRecovery();
    error OnlyGuard();
    error NotMature();
    error ZeroAddress();

    constructor(address guard) EIP712("MTW RotationTimelock", "1") {
        if (guard == address(0)) revert ZeroAddress();
        GUARD = guard;
    }

    /// @inheritdoc IRotationTimelock
    function propose(uint8 kind, address oldValue, address newValue) external returns (bytes32 id) {
        address safe = msg.sender;
        ISecurityGuard guard = ISecurityGuard(GUARD);
        if (!guard.isRegistered(safe)) revert NotRegisteredSafe();
        if (kind > uint8(type(RotationKind).max)) revert InvalidKind();
        RotationKind k = RotationKind(kind);
        bytes32 current = _active[safe][k];
        // Slither (incorrect-equality): comparación de un enum de estado, no de saldos.
        // slither-disable-next-line incorrect-equality
        if (current != bytes32(0) && _proposals[current].status == Status.Pending) revert ActiveProposalExists();
        if (newValue == address(0) || newValue == oldValue) revert InvalidNewValue();

        if (k == RotationKind.Guard || k == RotationKind.ModuleGuard) {
            bytes32 slot = k == RotationKind.Guard ? GUARD_STORAGE_SLOT : MODULE_GUARD_STORAGE_SLOT;
            if (_readAddressSlot(safe, slot) != oldValue) revert OldValueMismatch();
            IPolicyRegistry registry = IPolicyRegistry(guard.POLICY_REGISTRY());
            address successor = k == RotationKind.Guard
                ? registry.successorGuardOf(oldValue)
                : registry.successorModuleGuardOf(oldValue);
            if (successor == address(0) || successor != newValue) revert SuccessorNotRegistered();
        } else {
            if (guard.roleOf(safe, oldValue) != k.roleOf()) revert OldValueMismatch();
            if (guard.roleOf(safe, newValue) != Role.None || newValue == safe) revert InvalidNewValue();
        }

        // uint64 de segundos alcanza hasta el año 584.942.417.355; block.timestamp + demora nunca lo excede.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 executableAt = uint64(block.timestamp + DELAY);
        id = keccak256(abi.encode(block.chainid, address(this), safe, k, oldValue, newValue, ++_count[safe]));
        // uint64 de segundos alcanza hasta el año 584.942.417.355; block.timestamp + demora nunca lo excede.
        // forge-lint: disable-next-line(unsafe-typecast)
        _proposals[id] = Proposal(safe, k, oldValue, newValue, uint64(block.timestamp), executableAt, Status.Pending);
        _active[safe][k] = id;
        emit RotationProposed(id, safe, k, oldValue, newValue, executableAt);
    }

    /// @inheritdoc IRotationTimelock
    function cancel(bytes32 id) external {
        Proposal storage p = _pending(id);
        if (msg.sender != p.safe) revert NotProposalSafe();
        _cancel(id, p, msg.sender);
    }

    /// @inheritdoc IRotationTimelock
    function cancelWithSignature(bytes32 id, bytes calldata signature) external {
        Proposal storage p = _pending(id);
        // ECDSA.recover exige 65 bytes, `v ∈ {27, 28}` y `s` en la mitad baja (sin maleabilidad).
        address signer = ECDSA.recover(cancelDigest(id), signature);
        Role role = ISecurityGuard(GUARD).roleOf(p.safe, signer);
        if (role != Role.User && role != Role.Recovery) revert NotCurrentUserOrRecovery();
        _cancel(id, p, signer);
    }

    /// @inheritdoc IRotationTimelock
    function markExecuted(bytes32 id) external {
        if (msg.sender != GUARD) revert OnlyGuard();
        Proposal storage p = _pending(id);
        // el timelock compara contra block.timestamp por diseño; los validadores sólo lo desplazan segundos frente a demoras de horas.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < p.executableAt) revert NotMature();
        p.status = Status.Executed;
        delete _active[p.safe][p.kind];
        emit RotationExecuted(id, p.safe);
    }

    /// @inheritdoc IRotationTimelock
    function getProposal(bytes32 id) external view returns (Proposal memory) {
        return _proposals[id];
    }

    /// @inheritdoc IRotationTimelock
    function activeProposal(address safe, RotationKind kind) external view returns (bytes32) {
        bytes32 id = _active[safe][kind];
        // Slither (incorrect-equality): comparación de un enum de estado, no de saldos.
        // slither-disable-next-line incorrect-equality
        return _proposals[id].status == Status.Pending ? id : bytes32(0);
    }

    /// @inheritdoc IRotationTimelock
    function executableProposal(address safe, RotationKind kind, address oldValue, address newValue)
        external
        view
        returns (bytes32)
    {
        bytes32 id = _active[safe][kind];
        Proposal storage p = _proposals[id];
        if (
            // el timelock compara contra block.timestamp por diseño; los validadores sólo lo desplazan segundos frente a demoras de horas.
            // forge-lint: disable-next-line(block-timestamp)
            p.status == Status.Pending && block.timestamp >= p.executableAt && p.oldValue == oldValue
                && p.newValue == newValue
        ) {
            return id;
        }
        return bytes32(0);
    }

    /// @inheritdoc IRotationTimelock
    function cancelDigest(bytes32 id) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CANCEL_ROTATION_TYPEHASH, id, _proposals[id].safe)));
    }

    /// @notice Separador de dominio EIP-712 vigente.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _pending(bytes32 id) private view returns (Proposal storage p) {
        p = _proposals[id];
        if (p.status != Status.Pending) revert NotPending();
    }

    function _cancel(bytes32 id, Proposal storage p, address by) private {
        p.status = Status.Cancelled;
        delete _active[p.safe][p.kind];
        // la única llamada previa es la vista roleOf del SecurityGuard propio (inmutable y sin callbacks).
        // forge-lint: disable-next-line(reentrancy-events)
        emit RotationCancelled(id, p.safe, by);
    }

    function _readAddressSlot(address safe, bytes32 slot) private view returns (address) {
        // el slot de la Safe guarda una dirección (20 bytes) alineada a la derecha; el truncado descarta sólo ceros.
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(uint256(bytes32(ISafe(safe).getStorageAt(uint256(slot), 1)))));
    }
}
