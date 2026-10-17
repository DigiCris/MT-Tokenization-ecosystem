// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {AdversarialBase} from "./AdversarialBase.sol";
import {ISafe} from "../../src/interfaces/ISafe.sol";

/// @notice P07.T01.h — replay en otro nonce, otra Safe y otra cadena, y nonce incorrecto (A12, A13): el hash EIP-712
///         de la SafeTx incluye chainId, la dirección de la Safe y el nonce.
contract ReplayAttackTest is AdversarialBase {
    function test_replayAfterExecutionFails() public {
        SafeTx memory t = _call(ext.usdc, _transfer(dest, 10e6));
        bytes memory sigs = _sigs(_txHash(safe, t, safe.nonce()), _pair(userPk, executorPk));
        assertTrue(_execRaw(safe, executor, t, sigs));
        for (uint256 i; i < 3; ++i) {
            vm.expectRevert(bytes("GS026"));
            _execRaw(safe, executor, t, sigs);
        }
        assertEq(usdc.balanceOf(dest), 10e6, "una sola vez");
    }

    /// Firmas para un nonce futuro o pasado no sirven en el nonce actual.
    function test_wrongNonceFails() public {
        SafeTx memory t = _call(ext.usdc, _transfer(dest, 1e6));
        uint256 n = safe.nonce();
        bytes memory future = _sigs(_txHash(safe, t, n + 1), _pair(userPk, executorPk));
        vm.expectRevert(bytes("GS026"));
        _execRaw(safe, executor, t, future);
        bytes memory past = _sigs(_txHash(safe, t, n - 1), _pair(userPk, executorPk));
        vm.expectRevert(bytes("GS026"));
        _execRaw(safe, executor, t, past);
        _assertSafeUntouched();
    }

    /// Firmas de esta Safe usadas en otra Safe con las mismas claves.
    function test_replayOnAnotherSafeFails() public {
        ISafe twin = _createWallet(userKey, recoveryKey, executor, 5);
        _fund(ext.usdc, address(twin), SAFE_FUNDS);
        SafeTx memory t = _call(ext.usdc, _transfer(dest, 1e6));
        bytes memory sigs = _sigs(_txHash(safe, t, twin.nonce()), _pair(userPk, executorPk));
        vm.expectRevert(bytes("GS026"));
        _execRaw(twin, executor, t, sigs);
        assertEq(usdc.balanceOf(address(twin)), SAFE_FUNDS);
    }

    /// La misma SafeTx firmada para otra cadena (chainId 1 y 10).
    function test_replayFromAnotherChainFails() public {
        SafeTx memory t = _call(ext.usdc, _transfer(dest, 1e6));
        uint256 n = safe.nonce();
        uint64[2] memory chains = [uint64(1), 10];
        for (uint256 i; i < chains.length; ++i) {
            vm.chainId(chains[i]);
            bytes memory foreign = _sigs(_txHash(safe, t, n), _pair(userPk, executorPk));
            vm.chainId(ext.chainId);
            vm.expectRevert(bytes("GS026"));
            _execRaw(safe, executor, t, foreign);
        }
        _assertSafeUntouched();
    }

    /// A13: un NoOp asistido con el nonce N invalida la SafeTx pendiente firmada para N.
    function test_noOpCancelsPendingSafeTx() public {
        SafeTx memory pending = _call(ext.usdc, _transfer(dest, 50e6));
        bytes memory pendingSigs = _sigs(_txHash(safe, pending, safe.nonce()), _pair(userPk, executorPk));
        assertTrue(_assisted(recoveryPk, address(safe), ""));
        vm.expectRevert(bytes("GS026"));
        _execRaw(safe, executor, pending, pendingSigs);
        _assertSafeUntouched();
    }
}
