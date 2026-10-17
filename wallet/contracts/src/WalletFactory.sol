// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {ISafe, ISafeProxyFactory} from "./interfaces/ISafe.sol";
import {ISecurityGuard} from "./interfaces/ISecurityGuard.sol";
import {IWalletFactory} from "./interfaces/IWalletFactory.sol";
import {IRotationTimelock} from "./interfaces/IRotationTimelock.sol";
import {SafeBootstrap} from "./SafeBootstrap.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title WalletFactory
/// @notice Crea y verifica las Safes 2-de-3 (U, R, S) del sistema ([C-FAC-01..06], V9 §16).
/// @dev Inmutable, sin owner y permissionless. El deploy y la inicialización son atómicos
///      (`createProxyWithNonceL2` con un initializer fijo): el backend sólo aporta U, R, S y el salt. Mientras dura
///      `createWallet` marca la dirección predicha en transient storage (`isCreating`), que el Guard exige en
///      `initializeSafe`; así sólo las Safes creadas por esta factory pueden registrarse ([C-GRD-01]).
contract WalletFactory is IWalletFactory, ReentrancyGuardTransient {
    /// @notice Parámetros del constructor (direcciones y codehashes de `config/chains/base-mainnet.json`).
    struct Config {
        address safeProxyFactory;
        address safeSingleton;
        address safeBootstrap;
        address securityGuard;
        address denyAllModuleGuard;
        address rotationTimelock;
        address policyRegistry;
        address destinationWhitelist;
        bytes32 safeSingletonCodehash;
        bytes32 safeProxyFactoryCodehash;
        bytes32 safeProxyRuntimeCodehash;
        bytes32 proxyCreationCodeHash;
        uint256 chainId;
    }

    /// @notice Threshold de toda Safe del sistema.
    uint256 public constant THRESHOLD = 2;
    /// @notice Versión de Safe exigida.
    string public constant SAFE_VERSION = "1.5.0";

    bytes32 private constant GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 private constant MODULE_GUARD_SLOT = 0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;
    bytes32 private constant FALLBACK_SLOT = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;
    address private constant SENTINEL = address(0x1);

    address public immutable SAFE_PROXY_FACTORY;
    address public immutable SAFE_SINGLETON;
    /// @inheritdoc IWalletFactory
    address public immutable SAFE_BOOTSTRAP;
    address public immutable SECURITY_GUARD;
    address public immutable DENY_ALL_MODULE_GUARD;
    address public immutable ROTATION_TIMELOCK;
    address public immutable POLICY_REGISTRY;
    address public immutable DESTINATION_WHITELIST;
    bytes32 public immutable SAFE_SINGLETON_CODEHASH;
    bytes32 public immutable SAFE_PROXY_FACTORY_CODEHASH;
    bytes32 public immutable SAFE_PROXY_RUNTIME_CODEHASH;
    bytes32 public immutable PROXY_CREATION_CODE_HASH;
    /// @notice `keccak256(proxyCreationCode ‖ uint256(uint160(SAFE_SINGLETON)))`, init code hash del CREATE2.
    bytes32 public immutable PROXY_INIT_CODE_HASH;
    uint256 public immutable CHAIN_ID;

    /// @inheritdoc IWalletFactory
    mapping(address safe => bool) public isWallet;

    /// @notice Safe creada y verificada por esta factory.
    event WalletCreated(
        address indexed safe,
        address userKey,
        address recoveryKey,
        address executor,
        uint256 saltNonce,
        bytes32 initializerHash
    );

    /// @notice La configuración del constructor no pasa `validateConfig` (`reason` indica qué falla).
    error InvalidConfig(bytes32 reason);
    error InvalidKeys();
    error AddressOccupied();
    error UnexpectedAddress();
    error VerificationFailed(bytes32 reason);

    /// @param cfg Direcciones y codehashes esperados.
    constructor(Config memory cfg) {
        bytes32 reason = validateConfig(cfg);
        if (reason != bytes32(0)) revert InvalidConfig(reason);
        bytes memory creationCode = ISafeProxyFactory(cfg.safeProxyFactory).proxyCreationCode();

        SAFE_PROXY_FACTORY = cfg.safeProxyFactory;
        SAFE_SINGLETON = cfg.safeSingleton;
        SAFE_BOOTSTRAP = cfg.safeBootstrap;
        SECURITY_GUARD = cfg.securityGuard;
        DENY_ALL_MODULE_GUARD = cfg.denyAllModuleGuard;
        ROTATION_TIMELOCK = cfg.rotationTimelock;
        POLICY_REGISTRY = cfg.policyRegistry;
        DESTINATION_WHITELIST = cfg.destinationWhitelist;
        SAFE_SINGLETON_CODEHASH = cfg.safeSingletonCodehash;
        SAFE_PROXY_FACTORY_CODEHASH = cfg.safeProxyFactoryCodehash;
        SAFE_PROXY_RUNTIME_CODEHASH = cfg.safeProxyRuntimeCodehash;
        PROXY_CREATION_CODE_HASH = cfg.proxyCreationCodeHash;
        PROXY_INIT_CODE_HASH = keccak256(abi.encodePacked(creationCode, uint256(uint160(cfg.safeSingleton))));
        CHAIN_ID = cfg.chainId;
    }

    /// @notice Initializer fijo de `Safe.setup` para (U, R, S) ([C-FAC-03]).
    function initializerFor(address userKey, address recoveryKey, address executor) public view returns (bytes memory) {
        address[] memory owners = new address[](3);
        owners[0] = userKey;
        owners[1] = recoveryKey;
        owners[2] = executor;
        return abi.encodeCall(
            ISafe.setup,
            (
                owners,
                THRESHOLD,
                SAFE_BOOTSTRAP,
                abi.encodeCall(SafeBootstrap.bootstrap, (userKey, recoveryKey, executor)),
                address(0),
                address(0),
                0,
                payable(address(0))
            )
        );
    }

    /// @notice Dirección CREATE2 de la Safe para (U, R, S, saltNonce) ([C-FAC-04], §3.2).
    function predictWalletAddress(address userKey, address recoveryKey, address executor, uint256 saltNonce)
        public
        view
        returns (address)
    {
        return _predict(initializerFor(userKey, recoveryKey, executor), saltNonce);
    }

    /// @notice Crea (o devuelve, si ya existe) la Safe de (U, R, S, saltNonce) y la verifica en la misma tx ([C-FAC-05]).
    function createWallet(address userKey, address recoveryKey, address executor, uint256 saltNonce)
        external
        nonReentrant
        returns (address safe)
    {
        bytes memory initializer = initializerFor(userKey, recoveryKey, executor);
        safe = _predict(initializer, saltNonce);
        _validateKeys(safe, userKey, recoveryKey, executor);
        if (isWallet[safe]) return safe;
        if (safe.code.length != 0) revert AddressOccupied();

        _setCreating(safe, true);
        ISafeProxyFactory proxyFactory = ISafeProxyFactory(SAFE_PROXY_FACTORY);
        // Slither (reentrancy-no-eth): `isWallet` se escribe después de la creación y lo leen funciones reentrables
        // (`verifyWallet` y el getter), que durante la creación devuelven false / NOT_WALLET (lo correcto). Ningún contrato
        // del sistema autoriza con `isWallet` (el Guard usa `isCreating`) y la única reentrada esperada es
        // `initializeSafe` → `isCreating` (view).
        // slither-disable-start reentrancy-no-eth
        // forge-lint: disable-next-line(reentrancy-no-eth)
        address deployed = proxyFactory.createProxyWithNonceL2(SAFE_SINGLETON, initializer, saltNonce);
        // slither-disable-end reentrancy-no-eth
        _setCreating(safe, false);
        if (deployed != safe) revert UnexpectedAddress();

        bytes32 reason = _verify(safe, true);
        if (reason != bytes32(0)) revert VerificationFailed(reason);
        ISecurityGuard.SafeRoles memory roles = ISecurityGuard(SECURITY_GUARD).rolesOf(safe);
        if (roles.userKey != userKey || roles.recoveryKey != recoveryKey || roles.executor != executor) {
            revert VerificationFailed("ROLES");
        }
        isWallet[safe] = true;
        // createWallet es nonReentrant; las llamadas previas son a la SafeProxyFactory verificada por codehash y a la Safe recién creada.
        // forge-lint: disable-next-line(reentrancy-events)
        emit WalletCreated(safe, userKey, recoveryKey, executor, saltNonce, keccak256(initializer));
    }

    /// @notice Verificación de conveniencia de una Safe del sistema ([C-FAC-06]); `reason` es 0 si `ok`.
    /// @dev Los frontends además verifican por lectura directa ([F-SEC-08]).
    function verifyWallet(address safe) external view returns (bool ok, bytes32 reason) {
        if (!isWallet[safe]) return (false, "NOT_WALLET");
        reason = _verify(safe, false);
        ok = reason == bytes32(0);
    }

    /// @inheritdoc IWalletFactory
    function isCreating(address safe) external view returns (bool creating) {
        bytes32 slot = _creatingSlot(safe);
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            creating := tload(slot)
        }
    }

    /// @dev Ítems de V9 §16 sobre la Safe: proxy, singleton, owners == roles del Guard, threshold, guard, module
    ///      guard, fallback, módulos, chainId y (al crear) nonce 0.
    function _verify(address safe, bool requireFreshNonce) private view returns (bytes32) {
        if (block.chainid != CHAIN_ID) return "CHAIN_ID";
        if (safe.codehash != SAFE_PROXY_RUNTIME_CODEHASH) return "PROXY_CODEHASH";
        // Con un singleton que no es una Safe, `getStorageAt` revierte: cuenta como singleton incorrecto.
        try ISafe(safe).getStorageAt(0, 1) returns (bytes memory word) {
            // el slot guarda una dirección (20 bytes) alineada a la derecha; el truncado descarta sólo ceros.
            // forge-lint: disable-next-line(unsafe-typecast)
            if (address(uint160(uint256(bytes32(word)))) != SAFE_SINGLETON) return "SINGLETON";
        } catch {
            return "SINGLETON";
        }
        ISecurityGuard.SafeRoles memory roles = ISecurityGuard(SECURITY_GUARD).rolesOf(safe);
        if (!roles.initialized) return "NOT_REGISTERED";
        address[] memory owners = ISafe(safe).getOwners();
        if (
            owners.length != 3 || owners[0] != roles.userKey || owners[1] != roles.recoveryKey
                || owners[2] != roles.executor
        ) return "OWNERS";
        if (ISafe(safe).getThreshold() != THRESHOLD) return "THRESHOLD";
        if (requireFreshNonce && ISafe(safe).nonce() != 0) return "NONCE";
        if (_slotAddress(safe, GUARD_SLOT) != SECURITY_GUARD) return "GUARD";
        if (_slotAddress(safe, MODULE_GUARD_SLOT) != DENY_ALL_MODULE_GUARD) return "MODULE_GUARD";
        if (_slotAddress(safe, FALLBACK_SLOT) != address(0)) return "FALLBACK";
        // Slither (unused-return): sólo importa si hay al menos un módulo; el cursor no se usa.
        // slither-disable-start unused-return
        // sólo importa si hay al menos un módulo; el cursor `next` no se usa.
        // forge-lint: disable-next-line(unused-return)
        (address[] memory modules,) = ISafe(safe).getModulesPaginated(SENTINEL, 1);
        // slither-disable-end unused-return
        if (modules.length != 0) return "MODULES";
        return bytes32(0);
    }

    /// @notice Verificación de la configuración de [C-FAC-02] contra esta factory: chainId, codehash de singleton y
    ///         proxy factory, hash de `proxyCreationCode`, `VERSION()` y el cableado de `SafeBootstrap`,
    ///         `SecurityGuard` y `RotationTimelock`. Devuelve 0 si todo coincide o el primer ítem que falla. La usa el
    ///         constructor y sirve para re-verificar un deploy on-chain (`VerifyDeployment`).
    function validateConfig(Config memory cfg) public view returns (bytes32) {
        if (block.chainid != cfg.chainId) return "CHAIN_ID";
        if (cfg.safeSingleton.codehash != cfg.safeSingletonCodehash) return "SAFE_SINGLETON_CODEHASH";
        if (cfg.safeProxyFactory.codehash != cfg.safeProxyFactoryCodehash) return "SAFE_PROXY_FACTORY_CODEHASH";
        if (keccak256(ISafeProxyFactory(cfg.safeProxyFactory).proxyCreationCode()) != cfg.proxyCreationCodeHash) {
            return "PROXY_CREATION_CODE";
        }
        if (keccak256(bytes(ISafe(cfg.safeSingleton).VERSION())) != keccak256(bytes(SAFE_VERSION))) {
            return "SAFE_VERSION";
        }
        SafeBootstrap bootstrap = SafeBootstrap(cfg.safeBootstrap);
        if (bootstrap.SECURITY_GUARD() != cfg.securityGuard) return "BOOTSTRAP_GUARD";
        if (bootstrap.DENY_ALL_MODULE_GUARD() != cfg.denyAllModuleGuard) return "BOOTSTRAP_MODULE_GUARD";
        if (bootstrap.SELF() != cfg.safeBootstrap) return "BOOTSTRAP_SELF";
        ISecurityGuard guard = ISecurityGuard(cfg.securityGuard);
        if (guard.WALLET_FACTORY() != address(this)) return "GUARD_FACTORY";
        if (guard.SAFE_L2_SINGLETON() != cfg.safeSingleton) return "GUARD_SINGLETON";
        if (guard.SAFE_PROXY_RUNTIME_CODEHASH() != cfg.safeProxyRuntimeCodehash) return "GUARD_PROXY_CODEHASH";
        if (guard.DENY_ALL_MODULE_GUARD() != cfg.denyAllModuleGuard) return "GUARD_MODULE_GUARD";
        if (guard.ROTATION_TIMELOCK() != cfg.rotationTimelock) return "GUARD_TIMELOCK";
        if (guard.POLICY_REGISTRY() != cfg.policyRegistry) return "GUARD_POLICY_REGISTRY";
        if (guard.DESTINATION_WHITELIST() != cfg.destinationWhitelist) return "GUARD_WHITELIST";
        if (IRotationTimelock(cfg.rotationTimelock).GUARD() != cfg.securityGuard) return "TIMELOCK_GUARD";
        return bytes32(0);
    }

    function _predict(bytes memory initializer, uint256 saltNonce) private view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), SAFE_PROXY_FACTORY, salt, PROXY_INIT_CODE_HASH))))
        );
    }

    function _validateKeys(address safe, address userKey, address recoveryKey, address executor) private pure {
        if (
            userKey == address(0) || recoveryKey == address(0) || executor == address(0) || userKey == SENTINEL
                || recoveryKey == SENTINEL || executor == SENTINEL || userKey == recoveryKey || userKey == executor
                || recoveryKey == executor || userKey == safe || recoveryKey == safe || executor == safe
        ) revert InvalidKeys();
    }

    function _setCreating(address safe, bool creating) private {
        bytes32 slot = _creatingSlot(safe);
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            tstore(slot, creating)
        }
    }

    function _creatingSlot(address safe) private pure returns (bytes32) {
        return keccak256(abi.encode("mtw.walletfactory.creating", safe));
    }

    function _slotAddress(address safe, bytes32 slot) private view returns (address) {
        // el slot de la Safe guarda una dirección (20 bytes) alineada a la derecha; el truncado descarta sólo ceros.
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(uint256(bytes32(ISafe(safe).getStorageAt(uint256(slot), 1)))));
    }
}
