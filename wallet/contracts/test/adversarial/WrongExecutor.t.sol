// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {AdversarialBase} from "./AdversarialBase.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";

/// @notice P07.T01.e — executor incorrecto (`msg.sender ≠ S`) y combinación de signers incorrecta: las firmas U+S
///         robadas no las transmite nadie más que S, una firma ajena no cuenta y R+S no hace lo que sólo hace U+S.
contract WrongExecutorAttackTest is AdversarialBase {
    function test_onlyExecutorCanSubmitAssisted() public {
        address[4] memory senders = [attacker, userKey, recoveryKey, makeAddr("relayer")];
        for (uint256 i; i < senders.length; ++i) {
            _execExpectRevert(
                safe,
                senders[i],
                _call(ext.usdc, _transfer(dest, 1e6)),
                _pair(userPk, executorPk),
                abi.encodeWithSelector(SecurityGuard.WrongExecutor.selector)
            );
        }
        _assertSafeUntouched();
    }

    /// Firma de una clave que no es owner (atacante) en lugar de U o de S.
    function test_foreignSignerRejectedBySafe() public {
        SafeTx memory t = _call(ext.usdc, _transfer(dest, 1e6));
        bytes memory sigs = _sigs(_txHash(safe, t, safe.nonce()), _pair(attackerPk, executorPk));
        vm.expectRevert(bytes("GS026"));
        _execRaw(safe, executor, t, sigs);
        sigs = _sigs(_txHash(safe, t, safe.nonce()), _pair(userPk, attackerPk));
        vm.expectRevert(bytes("GS026"));
        _execRaw(safe, executor, t, sigs);
        _assertSafeUntouched();
    }

    /// R + S no alcanza operaciones que sólo habilita U.
    function test_recoveryAndExecutorCannotActAsUser() public {
        _deny(recoveryPk, ext.usdc, _transfer(dest, 1e6), SecurityGuard.RecoveryCannotTransfer.selector);
        _deny(
            recoveryPk,
            address(sys.destinationWhitelist),
            _addDestination(attacker),
            SecurityGuard.RoleNotAllowed.selector
        );
        _deny(
            recoveryPk,
            ext.usdc,
            abi.encodeWithSignature("approve(address,uint256)", address(sys.swapExecutor), 1e6),
            SecurityGuard.RecoveryCanOnlyRevoke.selector
        );
        _assertSafeUntouched();
    }
}
