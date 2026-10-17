// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {AdversarialBase} from "./AdversarialBase.sol";
import {SystemDeployer} from "../../script/lib/SystemDeployer.sol";
import {ISafeProxyFactory, Operation} from "../../src/interfaces/ISafe.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";
import {WalletFactory} from "../../src/WalletFactory.sol";

/// @notice Cambia el singleton de la Safe que lo ejecuta por DELEGATECALL (slot 0).
contract SingletonSwapper {
    function swapTo(address singleton) external {
        assembly ("memory-safe") {
            sstore(0, singleton)
        }
    }
}

/// @notice P07.T01.m — implementación de Safe incorrecta (A11): otro singleton (Safe L1 1.5.0), otra proxy factory
///         (copia del bytecode oficial) u otra configuración de factory no producen una Safe registrada; una Safe del
///         sistema cuyo singleton cambia deja de verificar.
contract WrongImplementationAttackTest is AdversarialBase {
    address internal u;
    address internal r;
    address internal s;

    function setUp() public override {
        super.setUp();
        (u,) = makeAddrAndKey("wi-user");
        (r,) = makeAddrAndKey("wi-recovery");
        (s,) = makeAddrAndKey("wi-executor");
    }

    function test_otherSingletonCannotRegister() public {
        bytes memory init = sys.walletFactory.initializerFor(u, r, s);
        vm.expectRevert(bytes("GS000"));
        ISafeProxyFactory(ext.safeProxyFactory).createProxyWithNonceL2(ext.safeSingleton, init, 1);
        // Motivo exacto: un proxy canónico con el singleton L1 no pasa el chequeo de singleton.
        address proxy = ISafeProxyFactory(ext.safeProxyFactory).createProxyWithNonceL2(ext.safeSingleton, "", 2);
        assertEq(proxy.codehash, ext.proxyRuntimeCodehash);
        vm.prank(proxy);
        vm.expectRevert(SecurityGuard.WrongSingleton.selector);
        sys.securityGuard.initializeSafe(u, r, s);
    }

    /// Copia exacta de la SafeProxyFactory en otra dirección: el proxy es idéntico, pero sólo la `WalletFactory`
    /// pone la marca de creación que exige el Guard.
    function test_copiedProxyFactoryCannotRegister() public {
        address copied = makeAddr("copied-proxy-factory");
        vm.etch(copied, ext.safeProxyFactory.code);
        bytes memory init = sys.walletFactory.initializerFor(u, r, s);
        vm.expectRevert(bytes("GS000"));
        ISafeProxyFactory(copied).createProxyWithNonceL2(ext.safeL2Singleton, init, 3);
        address proxy = ISafeProxyFactory(copied).createProxyWithNonceL2(ext.safeL2Singleton, "", 4);
        assertEq(proxy.codehash, ext.proxyRuntimeCodehash);
        vm.prank(proxy);
        vm.expectRevert(SecurityGuard.NotCreatedByFactory.selector);
        sys.securityGuard.initializeSafe(u, r, s);
    }

    /// La configuración de la factory se re-verifica on-chain: otro singleton u otro codehash no validan.
    function test_factoryConfigWithOtherImplementationDoesNotValidate() public {
        WalletFactory.Config memory cfg = SystemDeployer.factoryConfig(ext, sys);
        cfg.safeSingleton = ext.safeSingleton;
        assertEq(sys.walletFactory.validateConfig(cfg), bytes32("SAFE_SINGLETON_CODEHASH"));
        cfg.safeSingletonCodehash = ext.safeSingleton.codehash;
        assertEq(sys.walletFactory.validateConfig(cfg), bytes32("GUARD_SINGLETON"));
        cfg = SystemDeployer.factoryConfig(ext, sys);
        cfg.safeProxyRuntimeCodehash = bytes32(uint256(1));
        assertEq(sys.walletFactory.validateConfig(cfg), bytes32("GUARD_PROXY_CODEHASH"));
        cfg = SystemDeployer.factoryConfig(ext, sys);
        cfg.proxyCreationCodeHash = bytes32(uint256(1));
        assertEq(sys.walletFactory.validateConfig(cfg), bytes32("PROXY_CREATION_CODE"));
        // Una factory nueva con otra implementación tampoco se puede desplegar.
        cfg = SystemDeployer.factoryConfig(ext, sys);
        cfg.safeSingleton = ext.safeSingleton;
        vm.expectRevert(
            abi.encodeWithSelector(WalletFactory.InvalidConfig.selector, bytes32("SAFE_SINGLETON_CODEHASH"))
        );
        new WalletFactory(cfg);
    }

    /// U+R pueden cambiar el singleton por camino soberano (soberanía), pero la Safe deja de verificar: el backend y
    /// los frontends no la tratan como ACTIVE.
    function test_swappedSingletonDetected() public {
        SingletonSwapper swapper = new SingletonSwapper();
        SafeTx memory t = _safeTx(
            address(swapper),
            0,
            abi.encodeCall(SingletonSwapper.swapTo, (ext.safeSingleton)),
            Operation.DelegateCall,
            0,
            0,
            0,
            address(0),
            address(0)
        );
        assertTrue(_sovereign(t));
        (bool ok, bytes32 reason) = sys.walletFactory.verifyWallet(address(safe));
        assertFalse(ok);
        assertEq(reason, bytes32("SINGLETON"));
    }
}
