// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";
import {OpType} from "./libraries/OpTypes.sol";
import {Role} from "./libraries/Roles.sol";

/// @title PolicyRegistry
/// @notice Registro on-chain de la política del camino asistido ([C-POL-01..06], ADR-005): permisos por
///         operación y rol, tokens soportados, swap executors, autorizaciones de migración excepcional,
///         guardianes y sucesores del Guard / module guard.
/// @dev Gobierna **sólo** el camino asistido; el Guard nunca lo consulta en el camino soberano ([C-POL-05]).
///      Modo `Bootstrap` (desarrollo de contratos): el admin modifica todo de inmediato. Modo `Restricted`
///      (staging/producción, unidireccional): toda alta pasa por propuesta del admin, espera 24 h y la activa
///      cualquiera; el admin o cualquier guardián la puede cancelar mientras está pendiente (la baja de un
///      guardián sólo la cancelan el admin u otros guardianes); las revocaciones son inmediatas y las puede
///      hacer el admin o cualquier guardián, en ambos modos (endurecer nunca espera).
contract PolicyRegistry is IPolicyRegistry {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Modo de operación del registro.
    enum Mode {
        Bootstrap,
        Restricted
    }

    /// @notice Tipo de alta con timelock.
    enum ChangeKind {
        OpPermission,
        SupportedToken,
        SwapExecutor,
        MigrationAuthorization,
        GuardianAdd,
        GuardianRemove,
        SuccessorGuard,
        SuccessorModuleGuard
    }

    /// @notice Estado de una alta con timelock.
    enum ChangeStatus {
        None,
        Pending,
        Activated,
        Cancelled
    }

    /// @notice Alta pendiente. `subject`/`target`/`value` dependen de `kind` (ver `_apply`).
    struct Change {
        ChangeKind kind;
        address subject;
        address target;
        uint256 value;
        uint64 activatesAt;
        ChangeStatus status;
    }

    /// @notice Permiso inicial del constructor.
    struct OpPermissionInit {
        OpType op;
        Role role;
    }

    /// @notice Token inicial del constructor.
    struct TokenInit {
        address token;
        uint8 decimals;
    }

    struct TokenInfo {
        bool supported;
        uint8 decimals;
    }

    /// @inheritdoc IPolicyRegistry
    address public immutable ADMIN;
    /// @notice Demora entre la propuesta y la activación de un alta.
    uint256 public constant ACTIVATION_DELAY = 24 hours;

    /// @notice Modo actual (`Bootstrap` → `Restricted`, sin vuelta atrás).
    Mode public mode;
    /// @notice Cantidad de altas propuestas (entra en el id de cada una).
    uint256 public changeCount;

    mapping(OpType op => mapping(Role role => bool)) private _opPermission;
    mapping(address token => TokenInfo) private _tokens;
    mapping(address executor => bool) private _swapExecutors;
    mapping(address oldSafe => mapping(address newSafe => bool)) private _migration;
    EnumerableSet.AddressSet private _guardians;
    mapping(address guard => address) private _successorGuard;
    mapping(address moduleGuard => address) private _successorModuleGuard;
    mapping(bytes32 id => Change) private _changes;

    event ModeRestricted();
    event OpPermissionSet(OpType indexed op, Role indexed role, bool allowed);
    event SupportedTokenSet(address indexed token, uint8 decimals, bool supported);
    event SwapExecutorSet(address indexed executor, bool registered);
    event MigrationAuthorizationSet(address indexed oldSafe, address indexed newSafe, bool authorized);
    event GuardianAdded(address indexed guardian);
    event GuardianRemoved(address indexed guardian);
    event SuccessorGuardSet(address indexed guard, address indexed successor);
    event SuccessorModuleGuardSet(address indexed moduleGuard, address indexed successor);
    event ChangeProposed(
        bytes32 indexed id, ChangeKind indexed kind, address subject, address target, uint256 value, uint64 activatesAt
    );
    event ChangeActivated(bytes32 indexed id);
    event ChangeCancelled(bytes32 indexed id, address indexed by);
    /// @notice Revocación inmediata (endurecimiento) hecha por el admin o un guardián.
    event Revoked(ChangeKind indexed kind, address indexed subject, address target, uint256 value, address indexed by);

    error NotAdmin();
    error NotAdminOrGuardian();
    error OnlyInBootstrap();
    error AlreadyRestricted();
    error InvalidOpPermission();
    error ZeroAddress();
    error AlreadyGuardian();
    error NotAGuardian();
    error ChangeNotPending();
    error ChangeNotMature();
    error GuardianCannotCancelOwnRemoval();

    modifier onlyAdmin() {
        if (msg.sender != ADMIN) revert NotAdmin();
        _;
    }

    modifier onlyAdminOrGuardian() {
        if (msg.sender != ADMIN && !_guardians.contains(msg.sender)) revert NotAdminOrGuardian();
        _;
    }

    modifier onlyBootstrap() {
        if (mode != Mode.Bootstrap) revert OnlyInBootstrap();
        _;
    }

    /// @param admin Governance Safe (multisig).
    /// @param initialMode `Restricted` en staging/producción (nace con el set V1, [C-POL-04]).
    /// @param initialGuardians Guardianes iniciales.
    /// @param permissions Permisos iniciales activos.
    /// @param tokens Tokens soportados iniciales.
    /// @param executors Swap executors iniciales.
    constructor(
        address admin,
        Mode initialMode,
        address[] memory initialGuardians,
        OpPermissionInit[] memory permissions,
        TokenInit[] memory tokens,
        address[] memory executors
    ) {
        if (admin == address(0)) revert ZeroAddress();
        ADMIN = admin;
        for (uint256 i; i < initialGuardians.length; ++i) {
            _addGuardian(initialGuardians[i]);
        }
        for (uint256 i; i < permissions.length; ++i) {
            _setOpPermission(permissions[i].op, permissions[i].role, true);
        }
        for (uint256 i; i < tokens.length; ++i) {
            _setToken(tokens[i].token, tokens[i].decimals, true);
        }
        for (uint256 i; i < executors.length; ++i) {
            _setExecutor(executors[i], true);
        }
        if (initialMode == Mode.Restricted) {
            mode = Mode.Restricted;
            emit ModeRestricted();
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Modo Bootstrap: cambios inmediatos del admin.

    /// @notice BOOTSTRAP: habilita o deshabilita de inmediato el opType `op` para `role`.
    function setOpPermission(OpType op, Role role, bool allowed) external onlyAdmin onlyBootstrap {
        _setOpPermission(op, role, allowed);
    }

    /// @notice BOOTSTRAP: alta o baja inmediata de un token soportado con sus decimales.
    function setSupportedToken(address token, uint8 decimals, bool supported) external onlyAdmin onlyBootstrap {
        _setToken(token, decimals, supported);
    }

    /// @notice BOOTSTRAP: alta o baja inmediata de un swap executor (requisitos de [C-SWP-05]).
    function setSwapExecutor(address executor, bool registered) external onlyAdmin onlyBootstrap {
        _setExecutor(executor, registered);
    }

    /// @notice BOOTSTRAP: autorización inmediata de migración excepcional `oldSafe → newSafe` (ADR-026).
    function setMigrationAuthorization(address oldSafe, address newSafe, bool authorized)
        external
        onlyAdmin
        onlyBootstrap
    {
        _setMigration(oldSafe, newSafe, authorized);
    }

    /// @notice BOOTSTRAP: alta inmediata de un guardián.
    function addGuardian(address guardian) external onlyAdmin onlyBootstrap {
        _addGuardian(guardian);
    }

    /// @notice BOOTSTRAP: baja inmediata de un guardián.
    function removeGuardian(address guardian) external onlyAdmin onlyBootstrap {
        _removeGuardian(guardian);
    }

    /// @notice BOOTSTRAP: sucesor inmediato de un Guard ([C-POL-06]).
    function setSuccessorGuard(address guard, address successor) external onlyAdmin onlyBootstrap {
        _setSuccessor(_successorGuard, guard, successor, false);
    }

    /// @notice BOOTSTRAP: sucesor inmediato de un module guard ([C-POL-06]).
    function setSuccessorModuleGuard(address moduleGuard, address successor) external onlyAdmin onlyBootstrap {
        _setSuccessor(_successorModuleGuard, moduleGuard, successor, true);
    }

    /// @notice Pasa a `Restricted` (unidireccional).
    function enterRestricted() external onlyAdmin {
        if (mode == Mode.Restricted) revert AlreadyRestricted();
        mode = Mode.Restricted;
        emit ModeRestricted();
    }

    // ---------------------------------------------------------------------------------------------
    // Altas con timelock de 24 h (obligatorias en Restricted).

    /// @notice Propone habilitar el opType `op` para `role`; se activa tras 24 h. Devuelve el id del alta.
    function proposeOpPermission(OpType op, Role role) external onlyAdmin returns (bytes32) {
        _validateOpPermission(op, role);
        return _propose(ChangeKind.OpPermission, address(0), address(0), (uint256(uint8(op)) << 8) | uint8(role));
    }

    /// @notice Propone un token soportado con sus decimales; se activa tras 24 h.
    function proposeSupportedToken(address token, uint8 decimals) external onlyAdmin returns (bytes32) {
        if (token == address(0)) revert ZeroAddress();
        return _propose(ChangeKind.SupportedToken, token, address(0), decimals);
    }

    /// @notice Propone un swap executor (requisitos de [C-SWP-05]); se activa tras 24 h.
    function proposeSwapExecutor(address executor) external onlyAdmin returns (bytes32) {
        if (executor == address(0)) revert ZeroAddress();
        return _propose(ChangeKind.SwapExecutor, executor, address(0), 0);
    }

    /// @notice Autorización de migración excepcional `oldSafe → newSafe` (ADR-026).
    function proposeMigrationAuthorization(address oldSafe, address newSafe) external onlyAdmin returns (bytes32) {
        if (oldSafe == address(0) || newSafe == address(0)) revert ZeroAddress();
        return _propose(ChangeKind.MigrationAuthorization, oldSafe, newSafe, 0);
    }

    /// @notice Propone el alta de un guardián; se activa tras 24 h.
    function proposeGuardianAdd(address guardian) external onlyAdmin returns (bytes32) {
        if (guardian == address(0)) revert ZeroAddress();
        if (_guardians.contains(guardian)) revert AlreadyGuardian();
        return _propose(ChangeKind.GuardianAdd, guardian, address(0), 0);
    }

    /// @notice Propone la baja de un guardián; sólo el admin u otros guardianes pueden cancelarla.
    function proposeGuardianRemove(address guardian) external onlyAdmin returns (bytes32) {
        if (!_guardians.contains(guardian)) revert NotAGuardian();
        return _propose(ChangeKind.GuardianRemove, guardian, address(0), 0);
    }

    /// @notice Sucesor de un Guard ([C-POL-06]); habilita [C-GRD-17] junto con la propuesta por Safe en el timelock.
    function proposeSuccessorGuard(address guard, address successor) external onlyAdmin returns (bytes32) {
        if (guard == address(0) || successor == address(0)) revert ZeroAddress();
        return _propose(ChangeKind.SuccessorGuard, guard, successor, 0);
    }

    /// @notice Sucesor de un module guard ([C-POL-06]); habilita el upgrade de [C-GRD-17] para el module guard.
    function proposeSuccessorModuleGuard(address moduleGuard, address successor) external onlyAdmin returns (bytes32) {
        if (moduleGuard == address(0) || successor == address(0)) revert ZeroAddress();
        return _propose(ChangeKind.SuccessorModuleGuard, moduleGuard, successor, 0);
    }

    /// @notice Activa un alta madura (cualquiera puede llamarla).
    function activateChange(bytes32 id) external {
        Change storage c = _changes[id];
        if (c.status != ChangeStatus.Pending) revert ChangeNotPending();
        // el timelock compara contra block.timestamp por diseño; los validadores sólo lo desplazan segundos frente a demoras de horas.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < c.activatesAt) revert ChangeNotMature();
        c.status = ChangeStatus.Activated;
        _apply(c);
        emit ChangeActivated(id);
    }

    /// @notice Cancela un alta pendiente. La baja de un guardián no la puede cancelar ese mismo guardián.
    function cancelChange(bytes32 id) external onlyAdminOrGuardian {
        Change storage c = _changes[id];
        if (c.status != ChangeStatus.Pending) revert ChangeNotPending();
        if (c.kind == ChangeKind.GuardianRemove && msg.sender == c.subject) revert GuardianCannotCancelOwnRemoval();
        c.status = ChangeStatus.Cancelled;
        emit ChangeCancelled(id, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Revocaciones inmediatas (admin o guardián, en ambos modos).

    /// @notice Revoca de inmediato el opType `op` para `role` (admin o guardián).
    function revokeOpPermission(OpType op, Role role) external onlyAdminOrGuardian {
        _setOpPermission(op, role, false);
        emit Revoked(
            ChangeKind.OpPermission, address(0), address(0), (uint256(uint8(op)) << 8) | uint8(role), msg.sender
        );
    }

    /// @notice Revoca de inmediato un token soportado (conserva sus decimales registrados).
    function revokeSupportedToken(address token) external onlyAdminOrGuardian {
        _setToken(token, _tokens[token].decimals, false);
        emit Revoked(ChangeKind.SupportedToken, token, address(0), 0, msg.sender);
    }

    /// @notice Revoca de inmediato un swap executor.
    function revokeSwapExecutor(address executor) external onlyAdminOrGuardian {
        _setExecutor(executor, false);
        emit Revoked(ChangeKind.SwapExecutor, executor, address(0), 0, msg.sender);
    }

    /// @notice Revoca de inmediato una autorización de migración excepcional.
    function revokeMigrationAuthorization(address oldSafe, address newSafe) external onlyAdminOrGuardian {
        _setMigration(oldSafe, newSafe, false);
        emit Revoked(ChangeKind.MigrationAuthorization, oldSafe, newSafe, 0, msg.sender);
    }

    /// @notice Revoca de inmediato el sucesor registrado de un Guard.
    function revokeSuccessorGuard(address guard) external onlyAdminOrGuardian {
        _successorGuard[guard] = address(0);
        emit SuccessorGuardSet(guard, address(0));
        emit Revoked(ChangeKind.SuccessorGuard, guard, address(0), 0, msg.sender);
    }

    /// @notice Revoca de inmediato el sucesor registrado de un module guard.
    function revokeSuccessorModuleGuard(address moduleGuard) external onlyAdminOrGuardian {
        _successorModuleGuard[moduleGuard] = address(0);
        emit SuccessorModuleGuardSet(moduleGuard, address(0));
        emit Revoked(ChangeKind.SuccessorModuleGuard, moduleGuard, address(0), 0, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Vistas.

    /// @inheritdoc IPolicyRegistry
    function isRestricted() external view returns (bool) {
        return mode == Mode.Restricted;
    }

    /// @inheritdoc IPolicyRegistry
    function isOpAllowed(OpType op, Role role) external view returns (bool) {
        if (op == OpType.Unknown) return mode == Mode.Bootstrap;
        if (mode == Mode.Bootstrap) return true;
        return _opPermission[op][role];
    }

    /// @notice Permiso registrado (independiente del modo).
    function opPermission(OpType op, Role role) external view returns (bool) {
        return _opPermission[op][role];
    }

    /// @inheritdoc IPolicyRegistry
    function isSupportedToken(address token) external view returns (bool) {
        return _tokens[token].supported;
    }

    /// @inheritdoc IPolicyRegistry
    function tokenDecimals(address token) external view returns (uint8) {
        return _tokens[token].decimals;
    }

    /// @inheritdoc IPolicyRegistry
    function isSwapExecutor(address executor) external view returns (bool) {
        return _swapExecutors[executor];
    }

    /// @inheritdoc IPolicyRegistry
    function isMigrationAuthorized(address oldSafe, address newSafe) external view returns (bool) {
        return _migration[oldSafe][newSafe];
    }

    /// @inheritdoc IPolicyRegistry
    function isGuardian(address account) external view returns (bool) {
        return _guardians.contains(account);
    }

    /// @notice Lista de guardianes vigentes.
    function guardians() external view returns (address[] memory) {
        return _guardians.values();
    }

    /// @inheritdoc IPolicyRegistry
    function successorGuardOf(address guard) external view returns (address) {
        return _successorGuard[guard];
    }

    /// @inheritdoc IPolicyRegistry
    function successorModuleGuardOf(address moduleGuard) external view returns (address) {
        return _successorModuleGuard[moduleGuard];
    }

    /// @notice Alta con timelock por id (estado, tipo, sujeto, destino, valor y activación).
    function getChange(bytes32 id) external view returns (Change memory) {
        return _changes[id];
    }

    // ---------------------------------------------------------------------------------------------
    // Internas.

    function _propose(ChangeKind kind, address subject, address target, uint256 value) private returns (bytes32 id) {
        id = keccak256(abi.encode(block.chainid, address(this), ++changeCount, kind, subject, target, value));
        // uint64 de segundos alcanza hasta el año 584.942.417.355; block.timestamp + demora nunca lo excede.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 activatesAt = uint64(block.timestamp + ACTIVATION_DELAY);
        _changes[id] = Change(kind, subject, target, value, activatesAt, ChangeStatus.Pending);
        emit ChangeProposed(id, kind, subject, target, value, activatesAt);
    }

    function _apply(Change storage c) private {
        ChangeKind kind = c.kind;
        if (kind == ChangeKind.OpPermission) {
            // c.value se codificó en _proposeOpPermission como opType << 8 | rol; ambos caben en uint8.
            // forge-lint: disable-next-line(unsafe-typecast)
            _setOpPermission(OpType(uint8(c.value >> 8)), Role(uint8(c.value)), true);
        } else if (kind == ChangeKind.SupportedToken) {
            // c.value guarda los decimales recibidos como uint8 en proposeSupportedToken.
            // forge-lint: disable-next-line(unsafe-typecast)
            _setToken(c.subject, uint8(c.value), true);
        } else if (kind == ChangeKind.SwapExecutor) {
            _setExecutor(c.subject, true);
        } else if (kind == ChangeKind.MigrationAuthorization) {
            _setMigration(c.subject, c.target, true);
        } else if (kind == ChangeKind.GuardianAdd) {
            _addGuardian(c.subject);
        } else if (kind == ChangeKind.GuardianRemove) {
            _removeGuardian(c.subject);
        } else if (kind == ChangeKind.SuccessorGuard) {
            _setSuccessor(_successorGuard, c.subject, c.target, false);
        } else {
            _setSuccessor(_successorModuleGuard, c.subject, c.target, true);
        }
    }

    function _validateOpPermission(OpType op, Role role) private pure {
        // una entrada inicial inválida debe abortar todo el deploy.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (op == OpType.Unknown || role == Role.None) revert InvalidOpPermission();
    }

    function _setOpPermission(OpType op, Role role, bool allowed) private {
        _validateOpPermission(op, role);
        _opPermission[op][role] = allowed;
        emit OpPermissionSet(op, role, allowed);
    }

    function _setToken(address token, uint8 decimals, bool supported) private {
        // una entrada inicial inválida debe abortar todo el deploy.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (token == address(0)) revert ZeroAddress();
        _tokens[token] = TokenInfo(supported, decimals);
        emit SupportedTokenSet(token, decimals, supported);
    }

    function _setExecutor(address executor, bool registered) private {
        // una entrada inicial inválida debe abortar todo el deploy.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (executor == address(0)) revert ZeroAddress();
        _swapExecutors[executor] = registered;
        emit SwapExecutorSet(executor, registered);
    }

    function _setMigration(address oldSafe, address newSafe, bool authorized) private {
        if (oldSafe == address(0) || newSafe == address(0)) revert ZeroAddress();
        _migration[oldSafe][newSafe] = authorized;
        emit MigrationAuthorizationSet(oldSafe, newSafe, authorized);
    }

    function _addGuardian(address guardian) private {
        // una entrada inicial inválida debe abortar todo el deploy.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (guardian == address(0)) revert ZeroAddress();
        // una entrada inicial inválida debe abortar todo el deploy.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (!_guardians.add(guardian)) revert AlreadyGuardian();
        emit GuardianAdded(guardian);
    }

    function _removeGuardian(address guardian) private {
        if (!_guardians.remove(guardian)) revert NotAGuardian();
        emit GuardianRemoved(guardian);
    }

    function _setSuccessor(mapping(address => address) storage map, address current, address successor, bool isModule)
        private
    {
        if (current == address(0)) revert ZeroAddress();
        map[current] = successor;
        if (isModule) emit SuccessorModuleGuardSet(current, successor);
        else emit SuccessorGuardSet(current, successor);
    }
}
