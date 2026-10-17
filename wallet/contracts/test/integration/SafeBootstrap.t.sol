// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {SystemFixture} from "../utils/SystemFixture.sol";
import {ISafe, ISafeProxyFactory} from "../../src/interfaces/ISafe.sol";
import {SafeBootstrap} from "../../src/SafeBootstrap.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";

/// @notice P05.T03 — [C-BST-01..02] y anti-suplantación de [C-GRD-01]: sólo las Safes que crea la WalletFactory
///         pueden registrarse en el Guard.
contract SafeBootstrapTest is SystemFixture {
    function setUp() public {
        _setUpSystem();
    }

    function test_immutables() public view {
        assertEq(sys.safeBootstrap.SECURITY_GUARD(), address(sys.securityGuard));
        assertEq(sys.safeBootstrap.DENY_ALL_MODULE_GUARD(), address(sys.denyAllModuleGuard));
        assertEq(sys.safeBootstrap.SELF(), address(sys.safeBootstrap));
    }

    function test_directCallReverts() public {
        vm.expectRevert(SafeBootstrap.OnlyDelegateCall.selector);
        sys.safeBootstrap.bootstrap(userKey, recoveryKey, executor);
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(SafeBootstrap.ZeroAddress.selector);
        new SafeBootstrap(address(0), address(sys.denyAllModuleGuard));
        vm.expectRevert(SafeBootstrap.ZeroAddress.selector);
        new SafeBootstrap(address(sys.securityGuard), address(0));
    }

    /// Una Safe creada directo con la SafeProxyFactory + SafeBootstrap (sin la WalletFactory) no puede
    /// registrarse: el setup revierte y la creación entera falla.
    function test_safeCreatedOutsideFactoryCannotRegister() public {
        (address u,) = makeAddrAndKey("outside-u");
        (address r,) = makeAddrAndKey("outside-r");
        (address s,) = makeAddrAndKey("outside-s");
        bytes memory init = sys.walletFactory.initializerFor(u, r, s);
        vm.expectRevert(bytes("GS000"));
        ISafeProxyFactory(ext.safeProxyFactory).createProxyWithNonceL2(ext.safeL2Singleton, init, 5);
    }

    /// Un contrato que imita a una Safe no puede registrarse (codehash distinto del proxy de la factory).
    function test_fakeSafeCannotRegister() public {
        FakeSafe fake = new FakeSafe();
        vm.expectRevert(SecurityGuard.NotSafeProxy.selector);
        fake.register(sys.securityGuard, userKey, recoveryKey, executor);
    }

    /// Una Safe real pero no creada por la factory (Safe pelada) tampoco: falta la marca transitoria.
    function test_realSafeOutsideFactoryCannotRegisterLater() public {
        (address a, uint256 pa) = makeAddrAndKey("plain-a");
        (address b, uint256 pb) = makeAddrAndKey("plain-b");
        address[] memory owners = new address[](2);
        owners[0] = a;
        owners[1] = b;
        ISafe plain = _deployPlainSafe(ext.safeProxyFactory, ext.safeL2Singleton, owners, 2, 99);
        bytes memory call = abi.encodeCall(SecurityGuard.initializeSafe, (userKey, recoveryKey, executor));
        bytes memory sigs = _sigs(_txHash(plain, _call(address(sys.securityGuard), call), plain.nonce()), _pair(pa, pb));
        vm.expectRevert(SecurityGuard.NotCreatedByFactory.selector);
        _execRaw(plain, a, _call(address(sys.securityGuard), call), sigs);
        assertFalse(sys.securityGuard.isRegistered(address(plain)));
    }

    function test_registeredSafeCannotReinitialize() public {
        vm.prank(address(safe));
        vm.expectRevert(SecurityGuard.NotCreatedByFactory.selector);
        sys.securityGuard.initializeSafe(userKey, recoveryKey, executor);
    }
}

contract FakeSafe {
    function register(SecurityGuard guard, address u, address r, address s) external {
        guard.initializeSafe(u, r, s);
    }
}
