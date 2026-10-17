// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AdversarialBase, IMultiSend} from "./AdversarialBase.sol";
import {Operation} from "../../src/interfaces/ISafe.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";

/// @notice Contrato que, ejecutado por DELEGATECALL desde la Safe, retiraría el guard y vaciaría los tokens.
contract DelegateCallPayload {
    bytes32 internal constant GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;

    function pwn(address token, address to) external {
        assembly ("memory-safe") {
            sstore(GUARD_SLOT, 0)
        }
        IERC20(token).transfer(to, IERC20(token).balanceOf(address(this)));
    }
}

/// @notice P07.T01.b — DELEGATECALL en el camino asistido (A8): ni MultiSend ni un contrato arbitrario corren con el
///         contexto de la Safe por U+S o R+S.
contract DelegateCallAttackTest is AdversarialBase {
    function test_delegateCallToPayloadFails() public {
        DelegateCallPayload payload = new DelegateCallPayload();
        SafeTx memory t = _safeTx(
            address(payload),
            0,
            abi.encodeCall(DelegateCallPayload.pwn, (ext.usdc, attacker)),
            Operation.DelegateCall,
            0,
            0,
            0,
            address(0),
            address(0)
        );
        _denyTx(t, userPk, SecurityGuard.DelegateCallForbidden.selector);
        _denyTx(t, recoveryPk, SecurityGuard.DelegateCallForbidden.selector);
        assertEq(_slot(GUARD_SLOT), address(sys.securityGuard), "guard intacto");
        _assertSafeUntouched();
    }

    /// MultiSend (approve + transfer en lote) necesita DELEGATECALL: prohibido en asistido.
    function test_multiSendBatchFails() public {
        bytes memory batch = bytes.concat(
            _packed(0, ext.usdc, 0, _transfer(dest, 1e6)), _packed(0, ext.usdc, 0, _transfer(attacker, 999e6))
        );
        SafeTx memory t = _safeTx(
            ext.multiSendCallOnly,
            0,
            abi.encodeCall(IMultiSend.multiSend, (batch)),
            Operation.DelegateCall,
            0,
            0,
            0,
            address(0),
            address(0)
        );
        _denyTx(t, userPk, SecurityGuard.DelegateCallForbidden.selector);
        _assertSafeUntouched();
    }

    /// Una operación permitida (transfer a destino activo) tampoco pasa si viaja como DELEGATECALL.
    function test_allowedOperationAsDelegateCallFails() public {
        SafeTx memory t =
            _safeTx(ext.usdc, 0, _transfer(dest, 1e6), Operation.DelegateCall, 0, 0, 0, address(0), address(0));
        _denyTx(t, userPk, SecurityGuard.DelegateCallForbidden.selector);
        _assertSafeUntouched();
    }
}
