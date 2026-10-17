// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {AdversarialBase, ISafeAdmin} from "./AdversarialBase.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";

/// @notice P07.T01.f — U sola, R sola y S sola (A1, A2, A3): ninguna clave alcanza el threshold 2, ni repitiendo su
///         firma, ni combinando su firma ECDSA con su propio hash aprobado on-chain.
contract SingleKeyAttackTest is AdversarialBase {
    function test_singleSignatureNeverReachesThreshold() public {
        SafeTx memory t = _call(ext.usdc, _transfer(dest, 1e6));
        uint256[3] memory keys = [userPk, recoveryPk, executorPk];
        for (uint256 i; i < 3; ++i) {
            uint256[] memory one = new uint256[](1);
            one[0] = keys[i];
            bytes memory sig = _sigs(_txHash(safe, t, safe.nonce()), one);
            vm.expectRevert(bytes("GS020"));
            _execRaw(safe, executor, t, sig);
        }
        _assertSafeUntouched();
    }

    function test_sameKeyTwiceRejected() public {
        SafeTx memory t = _call(ext.usdc, _transfer(dest, 1e6));
        uint256[3] memory keys = [userPk, recoveryPk, executorPk];
        for (uint256 i; i < 3; ++i) {
            bytes memory sig = _sigs(_txHash(safe, t, safe.nonce()), _pair(keys[i], keys[i]));
            vm.expectRevert(bytes("GS026"));
            _execRaw(safe, executor, t, sig);
        }
        _assertSafeUntouched();
    }

    /// S aprueba el hash on-chain y suma su firma ECDSA: sigue siendo un solo owner.
    function test_executorApprovedHashPlusOwnSignatureRejected() public {
        SafeTx memory t = _call(ext.usdc, _transfer(attacker, 500e6));
        bytes32 h = _txHash(safe, t, safe.nonce());
        vm.prank(executor);
        ISafeAdmin(address(safe)).approveHash(h);
        bytes memory approved = _approvedHashSig(executor);
        bytes memory own = _ecdsa(executorPk, h);
        vm.expectRevert(bytes("GS026"));
        _execRaw(safe, executor, t, bytes.concat(approved, own));
        _assertSafeUntouched();
    }

    /// La firma de S como "ejecutor" (`v = 1`, válida para la Safe porque S transmite) no cuenta en asistido.
    function test_executorImplicitApprovalRejectedInAssisted() public {
        SafeTx memory t = _call(ext.usdc, _transfer(dest, 1e6));
        bytes32 h = _txHash(safe, t, safe.nonce());
        bytes memory u = _ecdsa(userPk, h);
        bytes memory s = _approvedHashSig(executor);
        bytes memory sigs = userKey < executor ? bytes.concat(u, s) : bytes.concat(s, u);
        vm.expectRevert(SecurityGuard.UnsupportedSignatureType.selector);
        _execRaw(safe, executor, t, sigs);
        _assertSafeUntouched();
    }
}
