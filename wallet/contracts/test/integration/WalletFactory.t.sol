// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {SystemFixture} from "../utils/SystemFixture.sol";
import {ISafe, ISafeProxyFactory} from "../../src/interfaces/ISafe.sol";
import {ISecurityGuard} from "../../src/interfaces/ISecurityGuard.sol";
import {WalletFactory} from "../../src/WalletFactory.sol";
import {SafeBootstrap} from "../../src/SafeBootstrap.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";

/// @notice P05.T04 — [C-FAC-01..06] con la SafeProxyFactory y el singleton SafeL2 reales del fork.
contract WalletFactoryTest is SystemFixture {
    bytes32 internal constant GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 internal constant MODULE_GUARD_SLOT = 0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;
    bytes32 internal constant FALLBACK_SLOT = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    event WalletCreated(
        address indexed safe,
        address userKey,
        address recoveryKey,
        address executor,
        uint256 saltNonce,
        bytes32 initializerHash
    );

    function setUp() public {
        _setUpSystem();
    }

    function _slot(ISafe s, bytes32 slot) internal view returns (address) {
        return address(uint160(uint256(bytes32(s.getStorageAt(uint256(slot), 1)))));
    }

    /// V9 §16: owners, threshold, guard, module guard, fallback, módulos, singleton, codehash, nonce y roles.
    function test_createdSafeIsFullyConfigured() public view {
        address[] memory owners = safe.getOwners();
        assertEq(owners.length, 3);
        assertEq(owners[0], userKey);
        assertEq(owners[1], recoveryKey);
        assertEq(owners[2], executor);
        assertEq(safe.getThreshold(), 2);
        assertEq(safe.nonce(), 0);
        assertEq(_slot(safe, GUARD_SLOT), address(sys.securityGuard));
        assertEq(_slot(safe, MODULE_GUARD_SLOT), address(sys.denyAllModuleGuard));
        assertEq(_slot(safe, FALLBACK_SLOT), address(0));
        assertEq(_slot(safe, bytes32(0)), ext.safeL2Singleton);
        (address[] memory modules,) = safe.getModulesPaginated(address(1), 10);
        assertEq(modules.length, 0);
        assertEq(address(safe).codehash, ext.proxyRuntimeCodehash);
        ISecurityGuard.SafeRoles memory r = sys.securityGuard.rolesOf(address(safe));
        assertEq(r.userKey, userKey);
        assertEq(r.recoveryKey, recoveryKey);
        assertEq(r.executor, executor);
        assertTrue(r.initialized);
        assertEq(r.version, 1);
        assertTrue(sys.walletFactory.isWallet(address(safe)));
        (bool ok, bytes32 reason) = sys.walletFactory.verifyWallet(address(safe));
        assertTrue(ok);
        assertEq(reason, bytes32(0));
    }

    function test_predictionMatchesCreate2() public {
        (address u,) = makeAddrAndKey("u2");
        (address r,) = makeAddrAndKey("r2");
        (address s,) = makeAddrAndKey("s2");
        address predicted = sys.walletFactory.predictWalletAddress(u, r, s, 42);
        bytes memory init = sys.walletFactory.initializerFor(u, r, s);
        bytes32 salt = keccak256(abi.encodePacked(keccak256(init), uint256(42)));
        bytes memory creation = ISafeProxyFactory(ext.safeProxyFactory).proxyCreationCode();
        bytes32 initCodeHash = keccak256(abi.encodePacked(creation, uint256(uint160(ext.safeL2Singleton))));
        assertEq(predicted, vm.computeCreate2Address(salt, initCodeHash, ext.safeProxyFactory));
        vm.expectEmit(address(sys.walletFactory));
        emit WalletCreated(predicted, u, r, s, 42, keccak256(init));
        assertEq(sys.walletFactory.createWallet(u, r, s, 42), predicted);
    }

    function test_initializerIsFixed() public view {
        bytes memory init = sys.walletFactory.initializerFor(userKey, recoveryKey, executor);
        address[] memory owners = new address[](3);
        owners[0] = userKey;
        owners[1] = recoveryKey;
        owners[2] = executor;
        bytes memory expected = abi.encodeCall(
            ISafe.setup,
            (
                owners,
                2,
                address(sys.safeBootstrap),
                abi.encodeCall(SafeBootstrap.bootstrap, (userKey, recoveryKey, executor)),
                address(0),
                address(0),
                0,
                payable(address(0))
            )
        );
        assertEq(init, expected);
    }

    function test_createWalletIsIdempotent() public {
        vm.recordLogs();
        address again = sys.walletFactory.createWallet(userKey, recoveryKey, executor, 0);
        assertEq(again, address(safe));
        assertEq(vm.getRecordedLogs().length, 0, "sin eventos ni efectos en la segunda llamada");
    }

    function test_invalidKeysRejected() public {
        address p = sys.walletFactory.predictWalletAddress(userKey, recoveryKey, userKey, 9);
        vm.expectRevert(WalletFactory.InvalidKeys.selector);
        sys.walletFactory.createWallet(userKey, recoveryKey, userKey, 9);
        vm.expectRevert(WalletFactory.InvalidKeys.selector);
        sys.walletFactory.createWallet(address(0), recoveryKey, executor, 9);
        vm.expectRevert(WalletFactory.InvalidKeys.selector);
        sys.walletFactory.createWallet(userKey, address(1), executor, 9);
        vm.expectRevert(WalletFactory.InvalidKeys.selector);
        sys.walletFactory.createWallet(userKey, recoveryKey, recoveryKey, 9);
        assertEq(p.code.length, 0);
    }

    /// Una dirección predicha ocupada por código ajeno revierte (no puede pasar en la práctica: sin la marca
    /// de la factory el setup revierte en [C-GRD-01]).
    function test_occupiedAddressReverts() public {
        address p = sys.walletFactory.predictWalletAddress(userKey, recoveryKey, executor, 77);
        vm.etch(p, hex"00");
        vm.expectRevert(WalletFactory.AddressOccupied.selector);
        sys.walletFactory.createWallet(userKey, recoveryKey, executor, 77);
    }

    function test_isCreatingOnlyDuringCreation() public view {
        assertFalse(sys.walletFactory.isCreating(address(safe)));
    }

    function test_verifyWalletDetectsDriftAndUnknownSafes() public {
        (bool ok, bytes32 reason) = sys.walletFactory.verifyWallet(makeAddr("random"));
        assertFalse(ok);
        assertEq(reason, bytes32("NOT_WALLET"));
        // U+R instalan un fallback handler por camino soberano: la verificación lo detecta.
        assertTrue(
            _exec(
                safe,
                makeAddr("relayer"),
                _call(
                    address(safe),
                    abi.encodeWithSignature("setFallbackHandler(address)", ext.compatibilityFallbackHandler)
                ),
                _pair(userPk, recoveryPk)
            )
        );
        (ok, reason) = sys.walletFactory.verifyWallet(address(safe));
        assertFalse(ok);
        assertEq(reason, bytes32("FALLBACK"));
    }

    // ------------------------------------------------------------------------------------------
    // [C-FAC-02] constructor

    function _config() internal view returns (WalletFactory.Config memory) {
        return WalletFactory.Config({
            safeProxyFactory: ext.safeProxyFactory,
            safeSingleton: ext.safeL2Singleton,
            safeBootstrap: address(sys.safeBootstrap),
            securityGuard: address(sys.securityGuard),
            denyAllModuleGuard: address(sys.denyAllModuleGuard),
            rotationTimelock: address(sys.rotationTimelock),
            policyRegistry: address(sys.policyRegistry),
            destinationWhitelist: address(sys.destinationWhitelist),
            safeSingletonCodehash: ext.safeL2SingletonCodehash,
            safeProxyFactoryCodehash: ext.safeProxyFactoryCodehash,
            safeProxyRuntimeCodehash: ext.proxyRuntimeCodehash,
            proxyCreationCodeHash: ext.proxyCreationCodeHash,
            chainId: ext.chainId
        });
    }

    function _reason(WalletFactory.Config memory c) internal view returns (bytes32) {
        return sys.walletFactory.validateConfig(c);
    }

    /// [C-FAC-02] ítem por ítem sobre la factory desplegada.
    function test_validateConfig() public {
        assertEq(_reason(_config()), bytes32(0));
        WalletFactory.Config memory c = _config();
        c.chainId = 1;
        assertEq(_reason(c), bytes32("CHAIN_ID"));
        c = _config();
        c.safeSingletonCodehash = keccak256("otro");
        assertEq(_reason(c), bytes32("SAFE_SINGLETON_CODEHASH"));
        c = _config();
        c.safeProxyFactoryCodehash = keccak256("otro");
        assertEq(_reason(c), bytes32("SAFE_PROXY_FACTORY_CODEHASH"));
        c = _config();
        c.proxyCreationCodeHash = keccak256("otro");
        assertEq(_reason(c), bytes32("PROXY_CREATION_CODE"));
        c = _config();
        c.securityGuard = makeAddr("otro-guard");
        assertEq(_reason(c), bytes32("BOOTSTRAP_GUARD"));
        c = _config();
        c.denyAllModuleGuard = makeAddr("otro-module-guard");
        assertEq(_reason(c), bytes32("BOOTSTRAP_MODULE_GUARD"));
        c = _config();
        c.safeProxyRuntimeCodehash = keccak256("otro");
        assertEq(_reason(c), bytes32("GUARD_PROXY_CODEHASH"));
        c = _config();
        c.rotationTimelock = makeAddr("otro-timelock");
        assertEq(_reason(c), bytes32("GUARD_TIMELOCK"));
        c = _config();
        c.policyRegistry = makeAddr("otro-registry");
        assertEq(_reason(c), bytes32("GUARD_POLICY_REGISTRY"));
        c = _config();
        c.destinationWhitelist = makeAddr("otra-whitelist");
        assertEq(_reason(c), bytes32("GUARD_WHITELIST"));
        // Un Guard y un bootstrap coherentes entre sí pero cableados a otra factory.
        SecurityGuard otherGuard = new SecurityGuard(
            address(sys.policyRegistry),
            address(sys.destinationWhitelist),
            address(sys.denyAllModuleGuard),
            makeAddr("otra-factory"),
            ext.safeL2Singleton,
            ext.proxyRuntimeCodehash,
            ext.permit2,
            address(0)
        );
        c = _config();
        c.securityGuard = address(otherGuard);
        c.safeBootstrap = address(new SafeBootstrap(address(otherGuard), address(sys.denyAllModuleGuard)));
        assertEq(_reason(c), bytes32("GUARD_FACTORY"));
    }

    /// Ítems que no se pueden desalinear con contratos reales (inmutables): se fuerza la respuesta de la vista.
    function test_validateConfigForcedMismatches() public {
        WalletFactory.Config memory c = _config();
        vm.mockCall(ext.safeL2Singleton, abi.encodeWithSignature("VERSION()"), abi.encode("1.4.1"));
        assertEq(_reason(c), bytes32("SAFE_VERSION"));
        vm.clearMockedCalls();
        vm.mockCall(address(sys.safeBootstrap), abi.encodeWithSignature("SELF()"), abi.encode(makeAddr("x")));
        assertEq(_reason(c), bytes32("BOOTSTRAP_SELF"));
        vm.clearMockedCalls();
        vm.mockCall(
            address(sys.securityGuard), abi.encodeWithSignature("SAFE_L2_SINGLETON()"), abi.encode(makeAddr("x"))
        );
        assertEq(_reason(c), bytes32("GUARD_SINGLETON"));
        vm.clearMockedCalls();
        vm.mockCall(
            address(sys.securityGuard), abi.encodeWithSignature("DENY_ALL_MODULE_GUARD()"), abi.encode(makeAddr("x"))
        );
        assertEq(_reason(c), bytes32("GUARD_MODULE_GUARD"));
        vm.clearMockedCalls();
        vm.mockCall(address(sys.rotationTimelock), abi.encodeWithSignature("GUARD()"), abi.encode(makeAddr("x")));
        assertEq(_reason(c), bytes32("TIMELOCK_GUARD"));
        vm.clearMockedCalls();
    }

    function test_constructorRevertsWithInvalidConfig() public {
        WalletFactory.Config memory c = _config();
        c.chainId = 1;
        vm.expectRevert(abi.encodeWithSelector(WalletFactory.InvalidConfig.selector, bytes32("CHAIN_ID")));
        new WalletFactory(c);
    }

    /// verifyWallet detecta cada deriva de la configuración de V9 §16.
    function test_verifyWalletReasons() public {
        address relayer = makeAddr("relayer");
        uint256[] memory ur = _pair(userPk, recoveryPk);
        ISafe s1 = _createWallet(userKey, recoveryKey, executor, 101);
        assertTrue(
            _exec(s1, relayer, _call(address(s1), abi.encodeWithSignature("enableModule(address)", makeAddr("m"))), ur)
        );
        (, bytes32 reason) = sys.walletFactory.verifyWallet(address(s1));
        assertEq(reason, bytes32("MODULES"));
        ISafe s2 = _createWallet(userKey, recoveryKey, executor, 102);
        assertTrue(_exec(s2, relayer, _call(address(s2), abi.encodeCall(ISafe.setModuleGuard, (address(0)))), ur));
        (, reason) = sys.walletFactory.verifyWallet(address(s2));
        assertEq(reason, bytes32("MODULE_GUARD"));
        ISafe s3 = _createWallet(userKey, recoveryKey, executor, 103);
        assertTrue(_exec(s3, relayer, _call(address(s3), abi.encodeCall(ISafe.setGuard, (address(0)))), ur));
        (, reason) = sys.walletFactory.verifyWallet(address(s3));
        assertEq(reason, bytes32("GUARD"));
        ISafe s4 = _createWallet(userKey, recoveryKey, executor, 104);
        assertTrue(_exec(s4, relayer, _call(address(s4), abi.encodeWithSignature("changeThreshold(uint256)", 1)), ur));
        (, reason) = sys.walletFactory.verifyWallet(address(s4));
        assertEq(reason, bytes32("THRESHOLD"));
        ISafe s5 = _createWallet(userKey, recoveryKey, executor, 105);
        assertTrue(
            _exec(
                s5,
                relayer,
                _call(address(s5), abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", makeAddr("o"), 2)),
                ur
            )
        );
        (, reason) = sys.walletFactory.verifyWallet(address(s5));
        assertEq(reason, bytes32("OWNERS"));
        // Simulaciones de estados imposibles por la Safe misma (singleton, código del proxy, otra cadena).
        ISafe s6 = _createWallet(userKey, recoveryKey, executor, 106);
        vm.store(address(s6), bytes32(0), bytes32(uint256(uint160(ext.safeSingleton))));
        (, reason) = sys.walletFactory.verifyWallet(address(s6));
        assertEq(reason, bytes32("SINGLETON"));
        // Singleton que no es una Safe: la lectura revierte y también se informa SINGLETON (sin revertir).
        vm.store(address(s6), bytes32(0), bytes32(uint256(uint160(ext.compatibilityFallbackHandler))));
        (, reason) = sys.walletFactory.verifyWallet(address(s6));
        assertEq(reason, bytes32("SINGLETON"));
        ISafe s7 = _createWallet(userKey, recoveryKey, executor, 107);
        vm.etch(address(s7), bytes.concat(address(s7).code, hex"00"));
        (, reason) = sys.walletFactory.verifyWallet(address(s7));
        assertEq(reason, bytes32("PROXY_CODEHASH"));
        vm.chainId(1);
        (, reason) = sys.walletFactory.verifyWallet(address(safe));
        assertEq(reason, bytes32("CHAIN_ID"));
    }

    // ------------------------------------------------------------------------------------------
    // Ramas defensivas de createWallet/verifyWallet: estados imposibles con la SafeProxyFactory, la Safe y el
    // Guard reales, simulados con vm.mockCall sobre la dirección afectada.

    function test_createWalletRejectsUnexpectedAddress() public {
        (address u,) = makeAddrAndKey("ua");
        vm.mockCall(
            ext.safeProxyFactory,
            abi.encodeWithSelector(ISafeProxyFactory.createProxyWithNonceL2.selector),
            abi.encode(makeAddr("otra"))
        );
        vm.expectRevert(WalletFactory.UnexpectedAddress.selector);
        sys.walletFactory.createWallet(u, recoveryKey, executor, 401);
    }

    function test_createWalletRejectsNonFreshNonce() public {
        (address u,) = makeAddrAndKey("ub");
        address p = sys.walletFactory.predictWalletAddress(u, recoveryKey, executor, 402);
        // injectCode = false: la dirección predicha sigue vacía y la factory puede crear la Safe ahí.
        vm.mockCall(p, abi.encodeWithSelector(ISafe.nonce.selector), abi.encode(uint256(1)), false);
        vm.expectRevert(abi.encodeWithSelector(WalletFactory.VerificationFailed.selector, bytes32("NONCE")));
        sys.walletFactory.createWallet(u, recoveryKey, executor, 402);
    }

    function test_createWalletRejectsRoleMismatch() public {
        (address u,) = makeAddrAndKey("uc");
        address p = sys.walletFactory.predictWalletAddress(u, recoveryKey, executor, 403);
        // Owners y roles coherentes entre sí (mismo conjunto, otro orden) pero distintos de las claves pedidas.
        address[] memory permuted = new address[](3);
        permuted[0] = recoveryKey;
        permuted[1] = u;
        permuted[2] = executor;
        vm.mockCall(p, abi.encodeWithSelector(ISafe.getOwners.selector), abi.encode(permuted), false);
        vm.mockCall(
            address(sys.securityGuard),
            abi.encodeWithSelector(ISecurityGuard.rolesOf.selector, p),
            abi.encode(ISecurityGuard.SafeRoles(recoveryKey, u, executor, true, 1))
        );
        vm.expectRevert(abi.encodeWithSelector(WalletFactory.VerificationFailed.selector, bytes32("ROLES")));
        sys.walletFactory.createWallet(u, recoveryKey, executor, 403);
    }

    function test_verifyWalletReportsUnregistered() public {
        vm.mockCall(
            address(sys.securityGuard),
            abi.encodeWithSelector(ISecurityGuard.rolesOf.selector, address(safe)),
            abi.encode(ISecurityGuard.SafeRoles(address(0), address(0), address(0), false, 0))
        );
        (bool ok, bytes32 reason) = sys.walletFactory.verifyWallet(address(safe));
        assertFalse(ok);
        assertEq(reason, bytes32("NOT_REGISTERED"));
    }
}
