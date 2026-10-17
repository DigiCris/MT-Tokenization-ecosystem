// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {AdversarialBase} from "./AdversarialBase.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";

/// @notice P07.T01.g — firmas malformadas (A7): longitud, `v` inválido, orden, duplicadas, tipos distintos de ECDSA en
///         asistido y bytes anexados para engañar la clasificación. El Guard clasifica sólo con las firmas del threshold
///         que la Safe validó.
contract MalformedSignaturesAttackTest is AdversarialBase {
    function _hashOf(SafeTx memory t) internal view returns (bytes32) {
        return _txHash(safe, t, safe.nonce());
    }

    function test_truncatedSignaturesRejected() public {
        SafeTx memory t = _call(ext.usdc, _transfer(dest, 1e6));
        bytes memory sigs = _sigs(_hashOf(t), _pair(userPk, executorPk));
        bytes memory truncated = new bytes(129);
        for (uint256 i; i < 129; ++i) {
            truncated[i] = sigs[i];
        }
        vm.expectRevert(bytes("GS020"));
        _execRaw(safe, executor, t, truncated);
        vm.expectRevert(bytes("GS020"));
        _execRaw(safe, executor, t, "");
        _assertSafeUntouched();
    }

    /// `v` fuera de {27, 28} (y distinto de 0, 1 y > 30): `ecrecover` no devuelve un owner.
    function test_invalidVRejected() public {
        SafeTx memory t = _call(ext.usdc, _transfer(dest, 1e6));
        bytes memory sigs = _sigs(_hashOf(t), _pair(userPk, executorPk));
        uint8[3] memory badV = [uint8(2), 26, 29];
        for (uint256 i; i < badV.length; ++i) {
            bytes memory bad = bytes.concat(sigs);
            bad[64] = bytes1(badV[i]);
            vm.expectRevert(bytes("GS026"));
            _execRaw(safe, executor, t, bad);
        }
        _assertSafeUntouched();
    }

    /// Orden descendente de signers y firma duplicada.
    function test_wrongOrderAndDuplicatesRejected() public {
        SafeTx memory t = _call(ext.usdc, _transfer(dest, 1e6));
        bytes32 h = _hashOf(t);
        bytes memory u = _ecdsa(userPk, h);
        bytes memory s = _ecdsa(executorPk, h);
        bytes memory descending = userKey < executor ? bytes.concat(s, u) : bytes.concat(u, s);
        vm.expectRevert(bytes("GS026"));
        _execRaw(safe, executor, t, descending);
        vm.expectRevert(bytes("GS026"));
        _execRaw(safe, executor, t, bytes.concat(s, s));
        _assertSafeUntouched();
    }

    /// Firma eth_sign (`v > 30`) del cofirmante: válida para la Safe, rechazada por el Guard en asistido.
    function test_ethSignRejectedInAssisted() public {
        SafeTx memory t = _call(ext.usdc, _transfer(dest, 1e6));
        bytes32 h = _hashOf(t);
        bytes memory u = _ethSign(userPk, h);
        bytes memory s = _ecdsa(executorPk, h);
        bytes memory sigs = userKey < executor ? bytes.concat(u, s) : bytes.concat(s, u);
        vm.expectRevert(SecurityGuard.UnsupportedSignatureType.selector);
        _execRaw(safe, executor, t, sigs);
        _assertSafeUntouched();
    }

    /// U+S válidas + una firma de R anexada: un parser que leyera todo vería U+R (soberano). El Guard lee sólo las
    /// del threshold, clasifica asistido y la salida a un destino no autorizado falla.
    function test_appendedRecoverySignatureDoesNotMakeItSovereign() public {
        SafeTx memory t = _call(ext.usdc, _transfer(attacker, 500e6));
        bytes32 h = _hashOf(t);
        bytes memory sigs = bytes.concat(_sigs(h, _pair(userPk, executorPk)), _ecdsa(recoveryPk, h));
        vm.expectRevert(SecurityGuard.DestinationNotWhitelisted.selector);
        _execRaw(safe, executor, t, sigs);
        // R+S con U anexada: sigue siendo R el cofirmante.
        sigs = bytes.concat(_sigs(h, _pair(recoveryPk, executorPk)), _ecdsa(userPk, h));
        vm.expectRevert(SecurityGuard.RecoveryCannotTransfer.selector);
        _execRaw(safe, executor, t, sigs);
        _assertSafeUntouched();
    }

    /// Basura anexada después de las firmas del threshold no cambia nada: la operación válida pasa igual y la
    /// inválida sigue fallando.
    function test_appendedGarbageIgnored() public {
        SafeTx memory ok = _call(ext.usdc, _transfer(dest, 1e6));
        bytes memory garbage = abi.encodePacked(bytes32(uint256(uint160(recoveryKey))), bytes32(0), uint8(1));
        bytes memory sigs = bytes.concat(_sigs(_hashOf(ok), _pair(userPk, executorPk)), garbage);
        assertTrue(_execRaw(safe, executor, ok, sigs));
        assertEq(usdc.balanceOf(dest), 1e6);
    }
}
