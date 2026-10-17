// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {AdversarialBase} from "./AdversarialBase.sol";
import {Operation} from "../../src/interfaces/ISafe.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";

/// @notice P07.T01.d — parámetros de gas y refund (vector de drenaje por refund de Safe) y `value` ≠ 0 en el camino
///         asistido: un S o un backend comprometidos no pueden cobrarse un refund ni mover ETH.
contract GasAndRefundAttackTest is AdversarialBase {
    function _with(uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver)
        internal
        view
        returns (SafeTx memory)
    {
        return _safeTx(
            ext.usdc, 0, _transfer(dest, 1e6), Operation.Call, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver
        );
    }

    function test_eachGasParameterRejected() public {
        bytes4 err = SecurityGuard.GasParametersForbidden.selector;
        _denyTx(_with(100_000, 0, 0, address(0), address(0)), userPk, err);
        _denyTx(_with(0, 1, 0, address(0), address(0)), userPk, err);
        _denyTx(_with(0, 0, 1, address(0), address(0)), userPk, err);
        _denyTx(_with(0, 0, 0, ext.usdc, address(0)), userPk, err);
        _denyTx(_with(0, 0, 0, address(0), attacker), userPk, err);
        _denyTx(_with(0, 0, 0, address(0), attacker), recoveryPk, err);
        _assertSafeUntouched();
    }

    /// Refund en USDC hacia el atacante con `baseGas` y `gasPrice` inflados.
    function test_tokenRefundDrainFails() public {
        SafeTx memory t = _safeTx(address(safe), 0, "", Operation.Call, 0, 5_000_000, 1e6, ext.usdc, attacker);
        _denyTx(t, userPk, SecurityGuard.GasParametersForbidden.selector);
        assertEq(usdc.balanceOf(attacker), 0);
        _assertSafeUntouched();
    }

    /// Refund en ETH hacia el atacante.
    function test_ethRefundDrainFails() public {
        vm.deal(address(safe), 1 ether);
        SafeTx memory t = _safeTx(address(safe), 0, "", Operation.Call, 0, 1_000_000, 100 gwei, address(0), attacker);
        _denyTx(t, userPk, SecurityGuard.GasParametersForbidden.selector);
        assertEq(address(safe).balance, 1 ether);
        assertEq(attacker.balance, 0);
    }

    /// V1 no mueve ETH por el camino asistido, ni siquiera a un destino activo.
    function test_valueTransferRejected() public {
        vm.deal(address(safe), 1 ether);
        _denyTx(
            _safeTx(dest, 1, "", Operation.Call, 0, 0, 0, address(0), address(0)),
            userPk,
            SecurityGuard.ValueTransferForbidden.selector
        );
        _denyTx(
            _safeTx(attacker, 1 ether, "", Operation.Call, 0, 0, 0, address(0), address(0)),
            userPk,
            SecurityGuard.ValueTransferForbidden.selector
        );
        _denyTx(
            _safeTx(ext.usdc, 1, _transfer(dest, 1e6), Operation.Call, 0, 0, 0, address(0), address(0)),
            userPk,
            SecurityGuard.ValueTransferForbidden.selector
        );
        assertEq(address(safe).balance, 1 ether);
    }
}
