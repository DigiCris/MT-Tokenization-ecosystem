// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {AdversarialBase} from "./AdversarialBase.sol";
import {ISafe} from "../../src/interfaces/ISafe.sol";
import {DestinationWhitelist} from "../../src/DestinationWhitelist.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";

/// @notice P07.T01.a — salida a un destino no autorizado (A9, A18): con U comprometida y S cooperando (o un backend
///         comprometido que pide la firma de S), los fondos no salen hacia un destino no whitelisteado, pendiente de
///         activación o whitelisteado en otra Safe; nadie más que la propia Safe escribe su whitelist.
contract NonWhitelistedSendAttackTest is AdversarialBase {
    function test_sendToNonWhitelistedDestinationFails() public {
        _deny(userPk, ext.usdc, _transfer(attacker, 100e6), SecurityGuard.DestinationNotWhitelisted.selector);
        _deny(userPk, ext.usdt, _transfer(attacker, 100e6), SecurityGuard.DestinationNotWhitelisted.selector);
        _deny(userPk, ext.usdc, _transfer(makeAddr("otro"), 1), SecurityGuard.DestinationNotWhitelisted.selector);
        _assertSafeUntouched();
    }

    /// El alta tiene 24 h de demora: hasta entonces el destino no sirve, y U o R lo pueden retirar.
    function test_sendToPendingDestinationFails() public {
        assertTrue(_assisted(userPk, address(sys.destinationWhitelist), _addDestination(attacker)));
        _deny(userPk, ext.usdc, _transfer(attacker, 1e6), SecurityGuard.DestinationNotWhitelisted.selector);
        vm.warp(vm.getBlockTimestamp() + 24 hours - 1);
        _deny(userPk, ext.usdc, _transfer(attacker, 1e6), SecurityGuard.DestinationNotWhitelisted.selector);
        assertTrue(_assisted(recoveryPk, address(sys.destinationWhitelist), _removeDestination(attacker)));
        vm.warp(vm.getBlockTimestamp() + 7 days);
        _deny(userPk, ext.usdc, _transfer(attacker, 1e6), SecurityGuard.DestinationNotWhitelisted.selector);
        _assertSafeUntouched();
    }

    /// La whitelist es por Safe: un destino activo en otra Safe no habilita la salida desde ésta.
    function test_destinationWhitelistedInAnotherSafeFails() public {
        (address u2, uint256 u2Pk) = makeAddrAndKey("mtw-other-user");
        (address r2,) = makeAddrAndKey("mtw-other-recovery");
        (address s2, uint256 s2Pk) = makeAddrAndKey("mtw-other-executor");
        ISafe other = _createWallet(u2, r2, s2, 77);
        assertTrue(
            _exec(other, s2, _call(address(sys.destinationWhitelist), _addDestination(attacker)), _pair(u2Pk, s2Pk))
        );
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        assertTrue(sys.destinationWhitelist.isWhitelisted(address(other), attacker));
        _deny(userPk, ext.usdc, _transfer(attacker, 1e6), SecurityGuard.DestinationNotWhitelisted.selector);
        _assertSafeUntouched();
    }

    /// R + S nunca transfieren (ni siquiera a un destino activo).
    function test_recoveryCannotSendEvenToWhitelisted() public {
        _deny(recoveryPk, ext.usdc, _transfer(dest, 1e6), SecurityGuard.RecoveryCannotTransfer.selector);
        _deny(recoveryPk, ext.usdc, _transfer(attacker, 1e6), SecurityGuard.RecoveryCannotTransfer.selector);
        _assertSafeUntouched();
    }

    /// Un tercero (backend, relayer o atacante) sólo puede escribir su propia lista: `msg.sender` es la Safe.
    function test_thirdPartyCannotWriteTheSafeWhitelist() public {
        vm.prank(attacker);
        sys.destinationWhitelist.addDestination(makeAddr("del-atacante"));
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        assertFalse(sys.destinationWhitelist.isWhitelisted(address(safe), makeAddr("del-atacante")));
        vm.prank(attacker);
        vm.expectRevert(DestinationWhitelist.NotWhitelisted.selector);
        sys.destinationWhitelist.removeDestination(dest);
        assertTrue(sys.destinationWhitelist.isWhitelisted(address(safe), dest));
    }

    /// El alta asistida tampoco acepta destinos que abrirían otra salida (sistema, tokens, executors, Permit2).
    function test_cannotWhitelistForbiddenDestinations() public {
        address[6] memory forbidden =
            [address(safe), address(sys.swapExecutor), ext.usdc, ext.permit2, address(sys.walletFactory), address(0)];
        for (uint256 i; i < forbidden.length; ++i) {
            _deny(
                userPk,
                address(sys.destinationWhitelist),
                _addDestination(forbidden[i]),
                SecurityGuard.InvalidDestination.selector
            );
        }
    }
}
