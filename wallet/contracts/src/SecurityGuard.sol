// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITransactionGuard} from "./interfaces/ITransactionGuard.sol";
import {ISecurityGuard} from "./interfaces/ISecurityGuard.sol";
import {ISafe, Operation} from "./interfaces/ISafe.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";
import {IDestinationWhitelist} from "./interfaces/IDestinationWhitelist.sol";
import {IRotationTimelock} from "./interfaces/IRotationTimelock.sol";
import {ISwapExecutor} from "./interfaces/ISwapExecutor.sol";
import {IWalletFactory} from "./interfaces/IWalletFactory.sol";
import {SafeSignatureParser} from "./libraries/SafeSignatureParser.sol";
import {CallDecoder} from "./libraries/CallDecoder.sol";
import {OpType} from "./libraries/OpTypes.sol";
import {Role, RotationKind, RolesLib} from "./libraries/Roles.sol";
import {RotationTimelock} from "./RotationTimelock.sol";

/// @title SecurityGuard
/// @notice Guard de transacciones inmutable y compartido por todas las Safes 2-de-3 (U, R, S) del sistema
///         ([C-GRD-01..17], ADR-003, ADR-004).
/// @dev Clasifica cada SafeTx con los signers de las primeras `threshold` firmas, que la Safe ya validó
///      (`checkSignatures` corre antes que `checkTransaction`):
///      - **Soberano** (S no está entre esos signers, p. ej. U+R): sin chequeos de negocio y sin ningún
///        `revert` posible; sólo sincroniza roles ante un `swapOwner` directo.
///      - **Asistido** (S es signer): exige `msg.sender == S`, exactamente dos firmas ECDSA {S, X} con
///        X ∈ {U, R}, CALL sin valor ni parámetros de gas, configuración intacta de la Safe y una operación
///        tipificada permitida para el rol de X; verifica post-condiciones tras la ejecución.
///      El contexto entre `checkTransaction` y `checkAfterExecution` vive en transient storage, apilado por
///      Safe y profundidad para soportar ejecuciones soberanas anidadas.
contract SecurityGuard is ITransactionGuard, ISecurityGuard {
    using RolesLib for RotationKind;
    using RolesLib for Role;

    /// @notice Piso de slippage on-chain de los swaps asistidos (0,5 %).
    uint256 public constant MAX_SWAP_SLIPPAGE_BPS = 50;

    bytes32 private constant GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 private constant MODULE_GUARD_SLOT = 0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;
    bytes32 private constant FALLBACK_SLOT = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;
    address private constant SENTINEL = address(0x1);

    uint256 private constant PATH_SOVEREIGN = 1;
    uint256 private constant PATH_ASSISTED = 2;
    uint256 private constant PATH_MASK = 0xff;
    uint256 private constant FLAG_SWAP_OWNER = 1 << 32;

    // Campos del contexto transitorio, como offsets desde la base de cada (safe, profundidad).
    uint256 private constant F_META = 0; // path | opType << 8 | rol << 16 | kind << 24 | flags
    uint256 private constant F_A = 1;
    uint256 private constant F_B = 2;
    uint256 private constant F_EXECUTOR = 3;
    uint256 private constant F_C = 4;
    uint256 private constant F_D = 5;
    uint256 private constant F_E = 6;
    uint256 private constant F_F = 7;
    uint256 private constant F_ID = 8;
    uint256 private constant F_COUNT = 9;

    /// @inheritdoc ISecurityGuard
    address public immutable POLICY_REGISTRY;
    /// @inheritdoc ISecurityGuard
    address public immutable DESTINATION_WHITELIST;
    /// @inheritdoc ISecurityGuard
    address public immutable DENY_ALL_MODULE_GUARD;
    /// @inheritdoc ISecurityGuard
    address public immutable WALLET_FACTORY;
    /// @inheritdoc ISecurityGuard
    address public immutable SAFE_L2_SINGLETON;
    /// @inheritdoc ISecurityGuard
    bytes32 public immutable SAFE_PROXY_RUNTIME_CODEHASH;
    /// @inheritdoc ISecurityGuard
    address public immutable ROTATION_TIMELOCK;
    /// @inheritdoc ISecurityGuard
    address public immutable PERMIT2;
    /// @inheritdoc ISecurityGuard
    address public immutable PREDECESSOR;

    mapping(address safe => SafeRoles) private _roles;

    /// @dev Contexto de una operación asistida para los post-checks de [C-GRD-04]. Campos según el opType:
    ///      SWAP: `a` = tokenIn, `b` = tokenOut, `executor`, `c`/`d` = saldos previos de tokenIn/tokenOut,
    ///      `e` = amountIn, `f` = minOut. ROTATION_EXECUTE: `a` = clave saliente, `b` = clave entrante, `id`,
    ///      `kind`. GUARD_UPGRADE: `a` = sucesor, `id`, `kind`.
    struct Ctx {
        address a;
        address b;
        address executor;
        uint256 c;
        uint256 d;
        uint256 e;
        uint256 f;
        bytes32 id;
        uint8 kind;
    }

    event SafeRegistered(address indexed safe, address userKey, address recoveryKey, address executor);
    event RolesSynced(address indexed safe, Role indexed role, address oldKey, address newKey);
    event RolesUpdated(address indexed safe, address userKey, address recoveryKey, address executor);
    event RoleRotated(address indexed safe, Role indexed role, address oldKey, address newKey);
    event GuardUpgradeExecuted(address indexed safe, RotationKind kind, address newValue);
    event RolesImported(
        address indexed safe, address indexed predecessor, address userKey, address recoveryKey, address executor
    );

    // Registro ([C-GRD-01]).
    error NotSafeProxy();
    error WrongSingleton();
    error NotCreatedByFactory();
    error AlreadyRegistered();
    error InvalidKeys();
    error OwnersMismatch();
    error ThresholdMismatch();
    error GuardNotInstalled();
    error ModuleGuardNotInstalled();
    error FallbackHandlerSet();
    error ModulesEnabled();
    // Camino asistido ([C-GRD-03..13], [C-GRD-17]).
    error UnregisteredSafe();
    error ConcurrentExecution();
    error WrongExecutor();
    error InvalidThreshold();
    error UnsupportedSignatureType();
    error UnknownCosigner();
    error DelegateCallForbidden();
    error GasParametersForbidden();
    error ValueTransferForbidden();
    error SafeConfigurationAltered();
    error EconomicAuthorityDenied();
    error AdminCallForbidden();
    error RoleNotAllowed();
    error ZeroAmount();
    error InvalidDestination();
    error DestinationNotWhitelisted();
    error RecoveryCannotTransfer();
    error MigrationRoleMismatch();
    error UnsupportedToken();
    error ApproveExceedsBalance();
    error RecoveryCanOnlyRevoke();
    error DecimalsMismatch();
    error MinOutBelowFloor();
    error DeadlineExpired();
    error InvalidRotationKind();
    error RotationOldMismatch();
    error InvalidRotationTarget();
    error RotationNotExecutable();
    error GuardUpgradeNotAuthorized();
    error OperationNotPermitted();
    error ExecutionFailed();
    error SwapPostConditionFailed();
    // `updateRoles` ([C-GRD-14]).
    error NotOwners();
    // Constructor.
    error ZeroAddress();

    /// @param policyRegistry `PolicyRegistry` del entorno.
    /// @param destinationWhitelist `DestinationWhitelist` del entorno.
    /// @param denyAllModuleGuard `DenyAllModuleGuard` del entorno.
    /// @param walletFactory Dirección **predicha** de la `WalletFactory` (CREATE del deployer, §6.1).
    /// @param safeL2Singleton SafeL2 v1.5.0.
    /// @param safeProxyRuntimeCodehash Codehash de runtime de todo `SafeProxy` de la factory v1.5.0.
    /// @param permit2 Permit2 (toda llamada a Permit2 se deniega en el camino asistido).
    /// @param predecessor Guard anterior cuyos roles se importan en el primer uso de cada Safe que instala este
    ///        Guard por [C-GRD-17]; `address(0)` en el primer Guard (V1).
    constructor(
        address policyRegistry,
        address destinationWhitelist,
        address denyAllModuleGuard,
        address walletFactory,
        address safeL2Singleton,
        bytes32 safeProxyRuntimeCodehash,
        address permit2,
        // Slither (missing-zero-check): address(0) es válido para el primer Guard (V1).
        // slither-disable-start missing-zero-check
        // address(0) es válido: el primer Guard (V1) no tiene predecesor.
        // forge-lint: disable-next-line(missing-zero-check)
        address predecessor
        // slither-disable-end missing-zero-check
    ) {
        if (
            policyRegistry == address(0) || destinationWhitelist == address(0) || denyAllModuleGuard == address(0)
                || walletFactory == address(0) || safeL2Singleton == address(0) || permit2 == address(0)
                || safeProxyRuntimeCodehash == bytes32(0)
        ) revert ZeroAddress();
        POLICY_REGISTRY = policyRegistry;
        DESTINATION_WHITELIST = destinationWhitelist;
        DENY_ALL_MODULE_GUARD = denyAllModuleGuard;
        WALLET_FACTORY = walletFactory;
        SAFE_L2_SINGLETON = safeL2Singleton;
        SAFE_PROXY_RUNTIME_CODEHASH = safeProxyRuntimeCodehash;
        PERMIT2 = permit2;
        PREDECESSOR = predecessor;
        ROTATION_TIMELOCK = address(new RotationTimelock(address(this)));
    }

    // =============================================================================================
    // Registro ([C-GRD-01]) y roles ([C-GRD-14]).

    /// @inheritdoc ISecurityGuard
    function initializeSafe(address userKey, address recoveryKey, address executor) external {
        address safe = msg.sender;
        if (safe.codehash != SAFE_PROXY_RUNTIME_CODEHASH) revert NotSafeProxy();
        if (_slotAddress(safe, bytes32(0)) != SAFE_L2_SINGLETON) revert WrongSingleton();
        if (!IWalletFactory(WALLET_FACTORY).isCreating(safe)) revert NotCreatedByFactory();
        if (_roles[safe].initialized) revert AlreadyRegistered();
        _validateKeys(safe, userKey, recoveryKey, executor);
        if (!_ownersAre(safe, userKey, recoveryKey, executor)) revert OwnersMismatch();
        if (ISafe(safe).getThreshold() != 2) revert ThresholdMismatch();
        if (_slotAddress(safe, GUARD_SLOT) != address(this)) revert GuardNotInstalled();
        if (_slotAddress(safe, MODULE_GUARD_SLOT) != DENY_ALL_MODULE_GUARD) revert ModuleGuardNotInstalled();
        if (_slotAddress(safe, FALLBACK_SLOT) != address(0)) revert FallbackHandlerSet();
        if (_hasModules(safe)) revert ModulesEnabled();
        // el registro emite SafeRegistered en la línea siguiente.
        // forge-lint: disable-next-line(missing-events-access-control)
        _roles[safe] = SafeRoles(userKey, recoveryKey, executor, true, 1);
        emit SafeRegistered(safe, userKey, recoveryKey, executor);
    }

    /// @inheritdoc ISecurityGuard
    /// @dev Sólo la propia Safe registrada. En la práctica sólo alcanzable por camino soberano, porque
    ///      [C-GRD-13] bloquea cualquier llamada al Guard en el camino asistido.
    function updateRoles(address userKey, address recoveryKey, address executor) external {
        address safe = msg.sender;
        SafeRoles storage r = _roles[safe];
        if (!r.initialized && !_importRoles(safe)) revert UnregisteredSafe();
        _validateKeys(safe, userKey, recoveryKey, executor);
        if (!ISafe(safe).isOwner(userKey) || !ISafe(safe).isOwner(recoveryKey) || !ISafe(safe).isOwner(executor)) {
            revert NotOwners();
        }
        r.userKey = userKey;
        r.recoveryKey = recoveryKey;
        r.executor = executor;
        r.version += 1;
        emit RolesUpdated(safe, userKey, recoveryKey, executor);
    }

    // =============================================================================================
    // Guard ([C-GRD-03], [C-GRD-04]).

    /// @inheritdoc ITransactionGuard
    function checkTransaction(
        address to,
        uint256 value,
        bytes memory data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures,
        address msgSender
    ) external override {
        // Paso 1: Safe registrada (o importada del Guard anterior en su primer uso, [C-GRD-17]).
        if (!_roles[msg.sender].initialized && !_importRoles(msg.sender)) revert UnregisteredSafe();
        // Pasos 1–4: apila el contexto y clasifica el camino con los signers del threshold.
        Role cosigner;
        {
            bytes32 txHash =
                _transactionHash(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver);
            cosigner = _enter(txHash, signatures, msgSender);
        }
        if (cosigner == Role.None) {
            _recordSovereign(to, operation, data);
            return;
        }
        // Paso 5: invariantes estructurales del camino asistido (`value` se valida en `_evaluate`).
        if (operation != Operation.Call) revert DelegateCallForbidden();
        if (safeTxGas != 0 || baseGas != 0 || gasPrice != 0 || gasToken != address(0) || refundReceiver != address(0)) {
            revert GasParametersForbidden();
        }
        // Pasos 5 (value) a 8.
        _recordAssisted(to, value, data, cosigner);
    }

    /// @inheritdoc ITransactionGuard
    function checkAfterExecution(bytes32, bool success) external override {
        address safe = msg.sender;
        bytes32 depthSlot = _depthSlot(safe);
        uint256 depth = _tload(depthSlot);
        if (depth == 0) return; // contexto ausente: nunca revierte
        // depth > 0 (verificado en la línea anterior): la resta no subdesborda.
        // nosemgrep: solidity.security.basic-arithmetic-underflow.basic-arithmetic-underflow
        _tstore(depthSlot, depth - 1);
        uint256 base = _ctxBase(safe, depth);
        uint256 meta = _tload(base + F_META);

        if (meta & PATH_MASK != PATH_ASSISTED) {
            // SOBERANO (o contexto desconocido): nunca revierte.
            if (success && meta & FLAG_SWAP_OWNER != 0) {
                _syncRole(safe, _tloadAddress(base + F_A), _tloadAddress(base + F_B));
            }
            _clearCtx(base);
            return;
        }

        // ASISTIDO, en el orden de [C-GRD-04].
        if (!success) revert ExecutionFailed();
        // el valor se escribió desde el mismo enum en este contrato; el uint8 está dentro de rango.
        // forge-lint: disable-next-line(unsafe-typecast)
        OpType op = OpType(uint8(meta >> 8));
        address expectedGuard = address(this);
        address expectedModuleGuard = DENY_ALL_MODULE_GUARD;
        if (op == OpType.Swap) {
            _postSwap(safe, base);
        } else if (op == OpType.RotationExecute) {
            // el valor se escribió desde el mismo enum en este contrato; el uint8 está dentro de rango.
            // forge-lint: disable-next-line(unsafe-typecast)
            Role rotated = RotationKind(uint8(meta >> 24)).roleOf();
            address oldKey = _tloadAddress(base + F_A);
            address newKey = _tloadAddress(base + F_B);
            _setKey(_roles[safe], rotated, newKey);
            // efectos antes de la única interacción (markExecuted, timelock propio); el linter no distingue ramas.
            // forge-lint: disable-next-line(reentrancy-events)
            emit RoleRotated(safe, rotated, oldKey, newKey);
            IRotationTimelock(ROTATION_TIMELOCK).markExecuted(bytes32(_tload(base + F_ID)));
        } else if (op == OpType.GuardUpgrade) {
            // el valor se escribió desde el mismo enum en este contrato; el uint8 está dentro de rango.
            // forge-lint: disable-next-line(unsafe-typecast)
            RotationKind kind = RotationKind(uint8(meta >> 24));
            address successor = _tloadAddress(base + F_A);
            if (kind == RotationKind.Guard) expectedGuard = successor;
            else expectedModuleGuard = successor;
            // efectos antes de la única interacción (markExecuted, timelock propio); el linter no distingue ramas.
            // forge-lint: disable-next-line(reentrancy-events)
            emit GuardUpgradeExecuted(safe, kind, successor);
            IRotationTimelock(ROTATION_TIMELOCK).markExecuted(bytes32(_tload(base + F_ID)));
        }
        if (!_stateIntact(safe, _roles[safe], expectedGuard, expectedModuleGuard)) revert SafeConfigurationAltered();
        _clearCtx(base);
    }

    /// @dev Paso 2: hash de la SafeTx en ejecución calculado por la propia Safe (el nonce ya se incrementó).
    function _transactionHash(
        address to,
        uint256 value,
        bytes memory data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver
    ) private view returns (bytes32) {
        uint256 txNonce = ISafe(msg.sender).nonce() - 1;
        return ISafe(msg.sender)
            .getTransactionHash(
                to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, txNonce
            );
    }

    /// @dev Pasos 1–4 de [C-GRD-03]: apila el contexto (`depth[safe]++`) y clasifica el camino con los signers
    ///      de las primeras `threshold` firmas. Devuelve el rol del cofirmante en el camino asistido o
    ///      `Role.None` en el soberano (que no puede revertir: la Safe ya validó esas mismas firmas).
    function _enter(bytes32 txHash, bytes memory signatures, address msgSender) private returns (Role) {
        address safe = msg.sender;
        bytes32 depthSlot = _depthSlot(safe);
        uint256 depth = _tload(depthSlot) + 1;
        _tstore(depthSlot, depth);

        uint256 threshold = ISafe(safe).getThreshold();
        (address[] memory signers, SafeSignatureParser.SigType[] memory types) =
            SafeSignatureParser.thresholdSigners(txHash, signatures, threshold);
        SafeRoles memory roles = _roles[safe];
        uint256 executorIndex = type(uint256).max;
        for (uint256 i; i < signers.length; ++i) {
            if (signers[i] == roles.executor) {
                executorIndex = i;
                break;
            }
        }
        if (executorIndex == type(uint256).max) return Role.None;

        // Paso 4: camino ASISTIDO.
        if (depth != 1) revert ConcurrentExecution();
        if (msgSender != roles.executor) revert WrongExecutor();
        if (threshold != 2 || signers.length != 2) revert InvalidThreshold();
        if (types[0] != SafeSignatureParser.SigType.Ecdsa || types[1] != SafeSignatureParser.SigType.Ecdsa) {
            revert UnsupportedSignatureType();
        }
        Role role = _roleOf(roles, signers[1 - executorIndex]);
        if (role != Role.User && role != Role.Recovery) revert UnknownCosigner();
        return role;
    }

    /// @dev Paso 3: marcador SOVEREIGN y, si es un `swapOwner` directo a la propia Safe, `(old, new)`.
    function _recordSovereign(address to, Operation operation, bytes memory data) private {
        uint256 base = _currentBase(msg.sender);
        uint256 meta = PATH_SOVEREIGN;
        if (to == msg.sender && operation == Operation.Call) {
            (bool isSwapOwner, address oldOwner, address newOwner) = CallDecoder.tryDecodeSwapOwner(data);
            if (isSwapOwner) {
                meta |= FLAG_SWAP_OWNER;
                _tstore(base + F_A, uint256(uint160(oldOwner)));
                _tstore(base + F_B, uint256(uint160(newOwner)));
            }
        }
        _tstore(base + F_META, meta);
    }

    /// @dev Pasos 5 (value) a 8: estado previo, clasificación, política y contexto para los post-checks.
    function _recordAssisted(address to, uint256 value, bytes memory data, Role role) private {
        address safe = msg.sender;
        (OpType op, Ctx memory ctx) = _evaluate(safe, _roles[safe], role, to, value, data);
        uint256 base = _currentBase(safe);
        _tstore(
            base + F_META,
            PATH_ASSISTED | (uint256(uint8(op)) << 8) | (uint256(uint8(role)) << 16) | (uint256(ctx.kind) << 24)
        );
        _tstore(base + F_A, uint256(uint160(ctx.a)));
        _tstore(base + F_B, uint256(uint160(ctx.b)));
        _tstore(base + F_EXECUTOR, uint256(uint160(ctx.executor)));
        _tstore(base + F_C, ctx.c);
        _tstore(base + F_D, ctx.d);
        _tstore(base + F_E, ctx.e);
        _tstore(base + F_F, ctx.f);
        _tstore(base + F_ID, uint256(ctx.id));
    }

    // =============================================================================================
    // Vistas ([C-GRD-02]).

    /// @inheritdoc ISecurityGuard
    function rolesOf(address safe) external view returns (SafeRoles memory) {
        return _effectiveRoles(safe);
    }

    /// @inheritdoc ISecurityGuard
    function roleOf(address safe, address account) external view returns (Role) {
        return _roleOf(_effectiveRoles(safe), account);
    }

    /// @inheritdoc ISecurityGuard
    function isRegistered(address safe) external view returns (bool) {
        return _effectiveRoles(safe).initialized;
    }

    /// @inheritdoc ISecurityGuard
    /// @dev Pre-check sin efectos que usan backend y signer: misma lógica que el camino asistido para el rol
    ///      dado (configuración de la Safe, operación tipificada, política), sin la verificación de firmas.
    ///      `reason` es el selector del error que revertiría el Guard (0 si `ok`).
    function evaluateAssisted(address safe, Role role, address to, uint256 value, bytes calldata data)
        external
        view
        returns (bool ok, bytes32 reason)
    {
        // Slither (unused-return): sólo importa si la clasificación revierte; el opType no se usa.
        // slither-disable-next-line unused-return
        try this.classifyAssisted(safe, role, to, value, data) returns (OpType) {
            return (true, bytes32(0));
        } catch (bytes memory err) {
            // se extrae a propósito sólo el selector (4 bytes) del error.
            // forge-lint: disable-next-line(unsafe-typecast)
            return (false, err.length >= 4 ? bytes32(bytes4(err)) : bytes32(0));
        }
    }

    /// @notice Clasifica una operación asistida para `role` y revierte con el error que aplicaría el Guard.
    function classifyAssisted(address safe, Role role, address to, uint256 value, bytes calldata data)
        external
        view
        returns (OpType op)
    {
        SafeRoles memory roles = _effectiveRoles(safe);
        if (!roles.initialized) revert UnregisteredSafe();
        if (role != Role.User && role != Role.Recovery) revert UnknownCosigner();
        (op,) = _evaluate(safe, roles, role, to, value, data);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(ITransactionGuard).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // =============================================================================================
    // Clasificación ([C-GRD-05..13], [C-GRD-17]).

    function _evaluate(address safe, SafeRoles memory roles, Role role, address to, uint256 value, bytes memory data)
        private
        view
        returns (OpType op, Ctx memory ctx)
    {
        if (value != 0) revert ValueTransferForbidden();
        if (!_stateIntact(safe, roles, address(this), DENY_ALL_MODULE_GUARD)) revert SafeConfigurationAltered();
        IPolicyRegistry registry = IPolicyRegistry(POLICY_REGISTRY);

        if (to == safe) {
            if (data.length == 0) {
                op = OpType.NoOp; // [C-GRD-05]
            } else {
                bytes4 selfSel = CallDecoder.selectorOf(data);
                if (selfSel == CallDecoder.SWAP_OWNER) {
                    (op, ctx) = _classifyRotationExecute(safe, roles, data);
                } else if (selfSel == CallDecoder.SET_GUARD || selfSel == CallDecoder.SET_MODULE_GUARD) {
                    (op, ctx) = _classifyGuardUpgrade(safe, role, selfSel, data, registry);
                } else {
                    revert AdminCallForbidden(); // [C-GRD-13]
                }
            }
        } else {
            bytes4 sel = CallDecoder.selectorOf(data);
            if (CallDecoder.isEconomicAuthority(sel) || to == PERMIT2) revert EconomicAuthorityDenied(); // [C-GRD-08]
            if (to == ROTATION_TIMELOCK) {
                if (sel == CallDecoder.PROPOSE) {
                    op = _classifyRotationPropose(safe, roles, role, data, registry);
                } else if (sel == CallDecoder.CANCEL) {
                    // Slither (unused-return): se decodifica sólo para exigir la longitud y el encoding exactos de cancel(bytes32).
                    // slither-disable-next-line unused-return
                    CallDecoder.decodeBytes32(data);
                    op = OpType.RotationCancel;
                } else {
                    revert AdminCallForbidden();
                }
            } else if (to == DESTINATION_WHITELIST) {
                op = _classifyWhitelist(safe, role, sel, data, registry);
            } else if (_isSystemContract(to)) {
                revert AdminCallForbidden(); // [C-GRD-13]
            } else if (registry.isSwapExecutor(to)) {
                if (sel != CallDecoder.SWAP) revert AdminCallForbidden();
                ctx = _classifySwap(safe, role, to, data, registry);
                op = OpType.Swap;
            } else if (sel == CallDecoder.TRANSFER) {
                op = _classifyTransfer(safe, roles, role, to, data, registry);
            } else if (sel == CallDecoder.APPROVE) {
                op = _classifyApprove(safe, role, to, data, registry);
            } else {
                op = OpType.Unknown;
            }
        }
        if (!registry.isOpAllowed(op, role)) revert OperationNotPermitted();
    }

    /// @dev [C-GRD-06] TRANSFER / MIGRATION_TRANSFER.
    function _classifyTransfer(
        address safe,
        SafeRoles memory roles,
        Role role,
        address token,
        bytes memory data,
        IPolicyRegistry registry
    ) private view returns (OpType) {
        (address dest, uint256 amount) = CallDecoder.decodeAddressAmount(data);
        if (amount == 0) revert ZeroAmount();
        if (_isForbiddenDestination(safe, dest, registry, false)) revert InvalidDestination();
        if (registry.isRestricted() && !registry.isSupportedToken(token)) revert UnsupportedToken();
        if (registry.isMigrationAuthorized(safe, dest)) {
            SafeRoles memory target = _effectiveRoles(dest);
            address healthyKey = role == Role.User ? roles.userKey : roles.recoveryKey;
            address targetKey = role == Role.User ? target.userKey : target.recoveryKey;
            if (!target.initialized || targetKey != healthyKey) revert MigrationRoleMismatch();
            return OpType.MigrationTransfer;
        }
        if (role != Role.User) revert RecoveryCannotTransfer();
        if (!IDestinationWhitelist(DESTINATION_WHITELIST).isWhitelisted(safe, dest)) {
            revert DestinationNotWhitelisted();
        }
        return OpType.Transfer;
    }

    /// @dev [C-GRD-07] APPROVE / APPROVE_REVOKE: sólo hacia un swap executor registrado y token soportado.
    function _classifyApprove(address safe, Role role, address token, bytes memory data, IPolicyRegistry registry)
        private
        view
        returns (OpType)
    {
        (address spender, uint256 amount) = CallDecoder.decodeAddressAmount(data);
        if (!registry.isSupportedToken(token)) revert UnsupportedToken();
        if (!registry.isSwapExecutor(spender)) revert EconomicAuthorityDenied();
        if (amount == 0) return OpType.ApproveRevoke;
        if (role != Role.User) revert RecoveryCanOnlyRevoke();
        if (amount > IERC20(token).balanceOf(safe)) revert ApproveExceedsBalance();
        return OpType.Approve;
    }

    /// @dev [C-GRD-09] SWAP: sólo U; tokens soportados con los mismos decimales, piso de slippage y deadline.
    ///      Guarda los saldos previos para el post-check.
    function _classifySwap(address safe, Role role, address executor, bytes memory data, IPolicyRegistry registry)
        private
        view
        returns (Ctx memory ctx)
    {
        if (role != Role.User) revert RoleNotAllowed();
        (address tokenIn, uint256 amountIn, uint256 minOut, uint256 deadline) = CallDecoder.decodeSwap(data);
        address tokenOut = _swapTokenOut(executor, tokenIn, registry);
        if (amountIn == 0) revert ZeroAmount();
        if (minOut < amountIn * (10_000 - MAX_SWAP_SLIPPAGE_BPS) / 10_000) revert MinOutBelowFloor();
        // solhint-disable-next-line not-rely-on-time
        // deadline de swap ([C-GRD-09]): comparar contra block.timestamp es la semántica pedida.
        // forge-lint: disable-next-line(block-timestamp)
        if (deadline < block.timestamp) revert DeadlineExpired();
        ctx.a = tokenIn;
        ctx.b = tokenOut;
        ctx.executor = executor;
        ctx.e = amountIn;
        ctx.f = minOut;
        ctx.c = IERC20(tokenIn).balanceOf(safe);
        ctx.d = IERC20(tokenOut).balanceOf(safe);
    }

    /// @dev `tokenIn` soportado, `tokenOut = executor.tokenOutFor(tokenIn)` soportado y mismos decimales.
    function _swapTokenOut(address executor, address tokenIn, IPolicyRegistry registry)
        private
        view
        returns (address tokenOut)
    {
        if (!registry.isSupportedToken(tokenIn)) revert UnsupportedToken();
        tokenOut = ISwapExecutor(executor).tokenOutFor(tokenIn);
        if (!registry.isSupportedToken(tokenOut)) revert UnsupportedToken();
        if (registry.tokenDecimals(tokenIn) != registry.tokenDecimals(tokenOut)) revert DecimalsMismatch();
    }

    /// @dev [C-GRD-10] WHITELIST_ADD (sólo U) / WHITELIST_REMOVE (U o R).
    function _classifyWhitelist(address safe, Role role, bytes4 sel, bytes memory data, IPolicyRegistry registry)
        private
        view
        returns (OpType)
    {
        if (sel == CallDecoder.ADD_DESTINATION) {
            if (role != Role.User) revert RoleNotAllowed();
            address dest = CallDecoder.decodeAddress(data);
            if (_isForbiddenDestination(safe, dest, registry, true)) revert InvalidDestination();
            return OpType.WhitelistAdd;
        }
        if (sel == CallDecoder.REMOVE_DESTINATION) {
            // Slither (unused-return): se decodifica sólo para exigir la longitud y el encoding exactos de removeDestination(address).
            // slither-disable-next-line unused-return
            CallDecoder.decodeAddress(data);
            return OpType.WhitelistRemove;
        }
        revert AdminCallForbidden();
    }

    /// @dev [C-GRD-11] ROTATION_PROPOSE: U propone U, R, S, GUARD o MODULE_GUARD; R sólo U o S.
    function _classifyRotationPropose(
        address safe,
        SafeRoles memory roles,
        Role role,
        bytes memory data,
        IPolicyRegistry registry
    ) private view returns (OpType) {
        (uint8 kindRaw, address oldValue, address newValue) = CallDecoder.decodePropose(data);
        if (kindRaw > uint8(type(RotationKind).max)) revert InvalidRotationKind();
        RotationKind kind = RotationKind(kindRaw);
        if (role == Role.Recovery && kind != RotationKind.User && kind != RotationKind.Executor) {
            revert RoleNotAllowed();
        }
        if (kind == RotationKind.Guard || kind == RotationKind.ModuleGuard) {
            address current = kind == RotationKind.Guard ? address(this) : DENY_ALL_MODULE_GUARD;
            if (oldValue != current) revert RotationOldMismatch();
            address successor = kind == RotationKind.Guard
                ? registry.successorGuardOf(current)
                : registry.successorModuleGuardOf(current);
            if (successor == address(0) || successor != newValue) revert GuardUpgradeNotAuthorized();
        } else {
            if (_keyOf(roles, kind.roleOf()) != oldValue) revert RotationOldMismatch();
            if (
                newValue == address(0) || newValue == SENTINEL || newValue == safe
                    || _roleOf(roles, newValue) != Role.None || _isSystemContract(newValue) || newValue == PERMIT2
            ) revert InvalidRotationTarget();
        }
        return OpType.RotationPropose;
    }

    /// @dev [C-GRD-12] ROTATION_EXECUTE: `swapOwner` contra una propuesta madura del timelock (U o R firman).
    function _classifyRotationExecute(address safe, SafeRoles memory roles, bytes memory data)
        private
        view
        returns (OpType, Ctx memory ctx)
    {
        // Slither (unused-return): prevOwner lo valida la propia Safe en swapOwner.
        // slither-disable-next-line unused-return
        (, address oldKey, address newKey) = CallDecoder.decodeSwapOwner(data);
        Role rotated = _roleOf(roles, oldKey);
        if (rotated == Role.None) revert RotationOldMismatch();
        RotationKind kind = rotated.kindOf();
        bytes32 id = IRotationTimelock(ROTATION_TIMELOCK).executableProposal(safe, kind, oldKey, newKey);
        if (id == bytes32(0)) revert RotationNotExecutable();
        ctx.id = id;
        ctx.kind = uint8(kind);
        ctx.a = oldKey;
        ctx.b = newKey;
        return (OpType.RotationExecute, ctx);
    }

    /// @dev [C-GRD-17] GUARD_UPGRADE: sucesor registrado en el PolicyRegistry y propuesta madura de 48 h (sólo U).
    function _classifyGuardUpgrade(address safe, Role role, bytes4 sel, bytes memory data, IPolicyRegistry registry)
        private
        view
        returns (OpType, Ctx memory ctx)
    {
        if (role != Role.User) revert RoleNotAllowed();
        address newValue = CallDecoder.decodeAddress(data);
        RotationKind kind = sel == CallDecoder.SET_GUARD ? RotationKind.Guard : RotationKind.ModuleGuard;
        address current = kind == RotationKind.Guard ? address(this) : DENY_ALL_MODULE_GUARD;
        address successor =
            kind == RotationKind.Guard ? registry.successorGuardOf(current) : registry.successorModuleGuardOf(current);
        if (successor == address(0) || successor != newValue) revert GuardUpgradeNotAuthorized();
        bytes32 id = IRotationTimelock(ROTATION_TIMELOCK).executableProposal(safe, kind, current, newValue);
        if (id == bytes32(0)) revert GuardUpgradeNotAuthorized();
        ctx.id = id;
        ctx.kind = uint8(kind);
        ctx.a = newValue;
        return (OpType.GuardUpgrade, ctx);
    }

    /// @dev Post-condiciones del swap ([C-GRD-09]): débito de tokenIn ≤ amountIn, crédito de tokenOut ≥ minOut y
    ///      allowance residual de tokenIn hacia el executor igual a 0.
    function _postSwap(address safe, uint256 base) private view {
        address tokenIn = _tloadAddress(base + F_A);
        if (IERC20(tokenIn).balanceOf(safe) + _tload(base + F_E) < _tload(base + F_C)) {
            revert SwapPostConditionFailed();
        }
        if (IERC20(_tloadAddress(base + F_B)).balanceOf(safe) < _tload(base + F_D) + _tload(base + F_F)) {
            revert SwapPostConditionFailed();
        }
        if (IERC20(tokenIn).allowance(safe, _tloadAddress(base + F_EXECUTOR)) != 0) revert SwapPostConditionFailed();
    }

    // =============================================================================================
    // Utilidades.

    function _validateKeys(address safe, address userKey, address recoveryKey, address executor) private pure {
        if (
            userKey == address(0) || recoveryKey == address(0) || executor == address(0) || userKey == SENTINEL
                || recoveryKey == SENTINEL || executor == SENTINEL || userKey == recoveryKey || userKey == executor
                || recoveryKey == executor || userKey == safe || recoveryKey == safe || executor == safe
        ) revert InvalidKeys();
    }

    function _roleOf(SafeRoles memory roles, address account) private pure returns (Role) {
        if (account == address(0)) return Role.None;
        if (account == roles.userKey) return Role.User;
        if (account == roles.recoveryKey) return Role.Recovery;
        if (account == roles.executor) return Role.Executor;
        return Role.None;
    }

    /// @dev Clave vigente de un rol de clave (U, R o S); sólo se llama con kinds de clave.
    function _keyOf(SafeRoles memory roles, Role role) private pure returns (address) {
        if (role == Role.User) return roles.userKey;
        if (role == Role.Recovery) return roles.recoveryKey;
        return roles.executor;
    }

    function _setKey(SafeRoles storage roles, Role role, address key) private {
        if (role == Role.User) roles.userKey = key;
        else if (role == Role.Recovery) roles.recoveryKey = key;
        else if (role == Role.Executor) roles.executor = key;
    }

    /// @dev Roles vigentes: los registrados aquí o, si la Safe todavía no usó este Guard, los del predecesor.
    function _effectiveRoles(address safe) private view returns (SafeRoles memory r) {
        r = _roles[safe];
        if (!r.initialized) r = _predecessorRoles(safe);
    }

    /// @dev Roles del Guard anterior para una Safe que ya instaló este Guard ([C-GRD-17]): la Safe tiene que ser un
    ///      `SafeProxy` de la factory v1.5.0, tener a este contrato en su slot de guard y estar registrada en el
    ///      predecesor (que sólo registra Safes de su `WalletFactory`). Nunca revierte.
    function _predecessorRoles(address safe) private view returns (SafeRoles memory r) {
        if (PREDECESSOR == address(0) || safe.codehash != SAFE_PROXY_RUNTIME_CODEHASH) return r;
        (bool ok, address installedGuard) = _tryGuardSlot(safe);
        if (!ok || installedGuard != address(this)) return r;
        try ISecurityGuard(PREDECESSOR).rolesOf(safe) returns (SafeRoles memory p) {
            if (p.initialized) r = p;
        } catch {}
    }

    /// @dev Slot de guard de `safe` sin revertir nunca: un `SafeProxy` con un singleton que no es una Safe puede
    ///      revertir o devolver datos malformados en `getStorageAt` (que `try/catch` no captura al decodificar).
    function _tryGuardSlot(address safe) private view returns (bool ok, address guard) {
        (bool success, bytes memory ret) = safe.staticcall(abi.encodeCall(ISafe.getStorageAt, (uint256(GUARD_SLOT), 1)));
        // `bytes` ABI-encoded de una palabra: offset (32) ‖ longitud (32) ‖ palabra.
        if (!success || ret.length != 96) return (false, address(0));
        (uint256 offset, uint256 length, bytes32 word) = abi.decode(ret, (uint256, uint256, bytes32));
        if (offset != 32 || length != 32) return (false, address(0));
        // el slot guarda una dirección (20 bytes) alineada a la derecha; el truncado descarta sólo ceros.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (true, address(uint160(uint256(word))));
    }

    /// @dev Importa los roles del predecesor en el primer uso de la Safe; devuelve false si no corresponde.
    function _importRoles(address safe) private returns (bool) {
        SafeRoles memory p = _predecessorRoles(safe);
        if (!p.initialized) return false;
        _roles[safe] = SafeRoles(p.userKey, p.recoveryKey, p.executor, true, p.version + 1);
        emit RolesImported(safe, PREDECESSOR, p.userKey, p.recoveryKey, p.executor);
        return true;
    }

    /// @dev Sincronización soberana de roles tras un `swapOwner` directo exitoso. Nunca revierte.
    function _syncRole(address safe, address oldKey, address newKey) private {
        SafeRoles storage r = _roles[safe];
        Role role = _roleOf(r, oldKey);
        if (role == Role.None) return;
        _setKey(r, role, newKey);
        // camino soberano: sin llamadas externas antes de este evento en ese camino.
        // forge-lint: disable-next-line(reentrancy-events)
        emit RolesSynced(safe, role, oldKey, newKey);
    }

    function _isSystemContract(address account) private view returns (bool) {
        return account == address(this) || account == POLICY_REGISTRY || account == DESTINATION_WHITELIST
            || account == DENY_ALL_MODULE_GUARD || account == WALLET_FACTORY || account == ROTATION_TIMELOCK
            || account == _safeBootstrap();
    }

    function _safeBootstrap() private view returns (address bootstrap) {
        if (WALLET_FACTORY.code.length == 0) return address(0);
        try IWalletFactory(WALLET_FACTORY).SAFE_BOOTSTRAP() returns (address b) {
            bootstrap = b;
        } catch {
            bootstrap = address(0);
        }
    }

    function _isForbiddenDestination(address safe, address dest, IPolicyRegistry registry, bool excludeExecutors)
        private
        view
        returns (bool)
    {
        return dest == address(0) || dest == safe || dest == PERMIT2 || _isSystemContract(dest)
            || registry.isSupportedToken(dest) || (excludeExecutors && registry.isSwapExecutor(dest));
    }

    /// @dev Estado intacto de [C-GRD-03] paso 6 y [C-GRD-04] (3). El module guard puede ser `DENY_ALL_MODULE_GUARD` o,
    ///      tras un GUARD_UPGRADE de tipo MODULE_GUARD ([C-GRD-17]), su sucesor activo en el `PolicyRegistry`; si el
    ///      sucesor se revoca, el camino asistido vuelve a quedar en fail-closed hasta que U+R lo restauren.
    function _stateIntact(address safe, SafeRoles memory roles, address expectedGuard, address expectedModuleGuard)
        private
        view
        returns (bool)
    {
        if (_slotAddress(safe, FALLBACK_SLOT) != address(0)) return false;
        if (_slotAddress(safe, GUARD_SLOT) != expectedGuard) return false;
        address moduleGuard = _slotAddress(safe, MODULE_GUARD_SLOT);
        if (
            moduleGuard != expectedModuleGuard
                && !(expectedModuleGuard == DENY_ALL_MODULE_GUARD && _isSuccessorModuleGuard(moduleGuard))
        ) {
            return false;
        }
        if (_hasModules(safe)) return false;
        if (ISafe(safe).getThreshold() != 2) return false;
        return _ownersAre(safe, roles.userKey, roles.recoveryKey, roles.executor);
    }

    function _isSuccessorModuleGuard(address moduleGuard) private view returns (bool) {
        return moduleGuard != address(0)
            && moduleGuard == IPolicyRegistry(POLICY_REGISTRY).successorModuleGuardOf(DENY_ALL_MODULE_GUARD);
    }

    function _ownersAre(address safe, address a, address b, address c) private view returns (bool) {
        address[] memory owners = ISafe(safe).getOwners();
        if (owners.length != 3) return false;
        for (uint256 i; i < 3; ++i) {
            address o = owners[i];
            if (o != a && o != b && o != c) return false;
        }
        return true;
    }

    function _hasModules(address safe) private view returns (bool) {
        // Slither (unused-return): sólo importa si hay al menos un módulo; el cursor no se usa.
        // slither-disable-start unused-return
        // sólo importa si hay al menos un módulo; el cursor `next` no se usa.
        // forge-lint: disable-next-line(unused-return)
        (address[] memory modules,) = ISafe(safe).getModulesPaginated(SENTINEL, 1);
        // slither-disable-end unused-return
        return modules.length != 0;
    }

    function _slotAddress(address safe, bytes32 slot) private view returns (address) {
        // el slot de la Safe guarda una dirección (20 bytes) alineada a la derecha; el truncado descarta sólo ceros.
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(uint256(bytes32(ISafe(safe).getStorageAt(uint256(slot), 1)))));
    }

    function _depthSlot(address safe) private pure returns (bytes32) {
        return keccak256(abi.encode("mtw.securityguard.depth", safe));
    }

    function _ctxBase(address safe, uint256 depth) private pure returns (uint256) {
        return uint256(keccak256(abi.encode("mtw.securityguard.context", safe, depth)));
    }

    /// @dev Base del contexto en el tope de la pila de `safe`.
    function _currentBase(address safe) private view returns (uint256) {
        return _ctxBase(safe, _tload(_depthSlot(safe)));
    }

    function _clearCtx(uint256 base) private {
        for (uint256 i; i < F_COUNT; ++i) {
            _tstore(base + i, 0);
        }
    }

    function _tloadAddress(uint256 slot) private view returns (address) {
        // el contexto transitorio guarda direcciones como uint160 extendidas a 256 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(_tload(slot)));
    }

    function _tload(bytes32 slot) private view returns (uint256) {
        return _tload(uint256(slot));
    }

    function _tload(uint256 slot) private view returns (uint256 v) {
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }

    function _tstore(bytes32 slot, uint256 v) private {
        _tstore(uint256(slot), v);
    }

    function _tstore(uint256 slot, uint256 v) private {
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }
}
