// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {AdversarialBase, ISafeAdmin} from "./AdversarialBase.sol";
import {ISafe, ISafeProxyFactory} from "../../src/interfaces/ISafe.sol";
import {SafeBootstrap} from "../../src/SafeBootstrap.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";

/// @notice P07.T01.l — inicialización de la factory (A11): una Safe sin bootstrap no se registra ni después, `setup` no
///         se puede re-ejecutar, el front-run de `createWallet` no le da nada al atacante y un initializer alterado cae
///         en otra dirección sin ocupar la predicha.
contract FactoryInitializationAttackTest is AdversarialBase {
    function _owners(address a, address b, address c) internal pure returns (address[] memory o) {
        o = new address[](3);
        o[0] = a;
        o[1] = b;
        o[2] = c;
    }

    /// Safe real con las mismas claves pero creada sin bootstrap: sin guard ni registro, y no se puede registrar después.
    function test_safeWithoutBootstrapNeverRegisters() public {
        ISafe plain = _deployPlainSafe(
            ext.safeProxyFactory, ext.safeL2Singleton, _owners(userKey, recoveryKey, executor), 2, 4242
        );
        assertFalse(sys.securityGuard.isRegistered(address(plain)));
        (bool ok, bytes32 reason) = sys.walletFactory.verifyWallet(address(plain));
        assertFalse(ok);
        assertEq(reason, bytes32("NOT_WALLET"));
        // Intento de registro tardío desde la propia Safe (U+R): el Guard exige la marca de la factory.
        vm.prank(address(plain));
        vm.expectRevert(SecurityGuard.NotCreatedByFactory.selector);
        sys.securityGuard.initializeSafe(userKey, recoveryKey, executor);
    }

    /// `setup` sólo corre una vez: ni el atacante ni una SafeTx asistida lo re-ejecutan.
    function test_setupCannotRunAgain() public {
        address[] memory evil = _owners(attacker, makeAddr("a2"), makeAddr("a3"));
        vm.prank(attacker);
        vm.expectRevert(bytes("GS200"));
        ISafeAdmin(address(safe)).setup(evil, 1, address(0), "", address(0), address(0), 0, payable(address(0)));
        _deny(
            userPk,
            address(safe),
            abi.encodeCall(ISafeAdmin.setup, (evil, 1, address(0), "", address(0), address(0), 0, payable(address(0)))),
            SecurityGuard.AdminCallForbidden.selector
        );
        assertTrue(safe.isOwner(userKey) && !safe.isOwner(attacker));
        assertEq(safe.getThreshold(), 2);
    }

    /// El atacante se adelanta a `createWallet`: la Safe queda con las claves del usuario y la llamada del usuario
    /// devuelve la misma dirección (idempotente).
    function test_frontRunCreateWalletGivesNothing() public {
        (address u,) = makeAddrAndKey("fr-user");
        (address r,) = makeAddrAndKey("fr-recovery");
        (address s,) = makeAddrAndKey("fr-executor");
        address predicted = sys.walletFactory.predictWalletAddress(u, r, s, 9);
        vm.prank(attacker);
        address created = sys.walletFactory.createWallet(u, r, s, 9);
        assertEq(created, predicted);
        assertEq(sys.walletFactory.createWallet(u, r, s, 9), predicted);
        ISafe w = ISafe(predicted);
        assertTrue(w.isOwner(u) && w.isOwner(r) && w.isOwner(s) && !w.isOwner(attacker));
        (bool ok,) = sys.walletFactory.verifyWallet(predicted);
        assertTrue(ok);
    }

    /// Initializer alterado (el atacante como owner) con el mismo saltNonce: otra dirección; la predicha sigue libre y
    /// la factory la crea bien.
    function test_alteredInitializerLandsElsewhere() public {
        (address u,) = makeAddrAndKey("ai-user");
        (address r,) = makeAddrAndKey("ai-recovery");
        (address s,) = makeAddrAndKey("ai-executor");
        address predicted = sys.walletFactory.predictWalletAddress(u, r, s, 11);
        bytes memory altered = abi.encodeCall(
            ISafe.setup,
            (
                _owners(attacker, r, s),
                2,
                address(sys.safeBootstrap),
                abi.encodeCall(SafeBootstrap.bootstrap, (attacker, r, s)),
                address(0),
                address(0),
                0,
                payable(address(0))
            )
        );
        // Además, fuera de `createWallet` el bootstrap del sistema no registra: la creación directa revierte.
        vm.prank(attacker);
        vm.expectRevert(bytes("GS000"));
        ISafeProxyFactory(ext.safeProxyFactory).createProxyWithNonceL2(ext.safeL2Singleton, altered, 11);
        assertEq(predicted.code.length, 0, "la direccion predicha sigue libre");
        assertEq(sys.walletFactory.createWallet(u, r, s, 11), predicted);
    }

    function test_bootstrapAndRegistrationEntryPointsClosed() public {
        vm.prank(attacker);
        vm.expectRevert(SafeBootstrap.OnlyDelegateCall.selector);
        sys.safeBootstrap.bootstrap(attacker, recoveryKey, executor);
        vm.prank(attacker);
        vm.expectRevert(SecurityGuard.NotSafeProxy.selector);
        sys.securityGuard.initializeSafe(attacker, recoveryKey, executor);
    }
}
