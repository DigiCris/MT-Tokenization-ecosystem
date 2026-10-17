// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ISafe, ISafeProxyFactory, Operation} from "../../src/interfaces/ISafe.sol";

/// @notice Construcción, firma y ejecución de SafeTx contra Safes reales (v1.5.0) en el fork.
abstract contract SafeHelpers is Test {
    struct SafeTx {
        address to;
        uint256 value;
        bytes data;
        Operation operation;
        uint256 safeTxGas;
        uint256 baseGas;
        uint256 gasPrice;
        address gasToken;
        address refundReceiver;
    }

    /// @notice Safe v1.5.0 "pelada" (sin guard, module guard ni módulos) creada con la factory real del fork.
    function _deployPlainSafe(
        address factory,
        address singleton,
        address[] memory owners,
        uint256 threshold,
        uint256 salt
    ) internal returns (ISafe) {
        bytes memory setup = abi.encodeCall(
            ISafe.setup, (owners, threshold, address(0), "", address(0), address(0), 0, payable(address(0)))
        );
        return ISafe(ISafeProxyFactory(factory).createProxyWithNonceL2(singleton, setup, salt));
    }

    /// @notice CALL sin valor ni parámetros de gas (forma del camino asistido).
    function _call(address to, bytes memory data) internal pure returns (SafeTx memory t) {
        t.to = to;
        t.data = data;
    }

    function _txHash(ISafe safe, SafeTx memory t, uint256 nonce) internal view returns (bytes32) {
        return safe.getTransactionHash(
            t.to, t.value, t.data, t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, nonce
        );
    }

    /// @notice Firma ECDSA estática `r ‖ s ‖ v` (v ∈ {27, 28}).
    function _ecdsa(uint256 pk, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hash);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Firma eth_sign (`v + 4` sobre el hash con prefijo).
    function _ethSign(uint256 pk, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash)));
        return abi.encodePacked(r, s, v + 4);
    }

    /// @notice Firma de hash aprobado / ejecutor (`v = 1`, owner en `r`).
    function _approvedHashSig(address owner) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(uint160(owner))), bytes32(0), uint8(1));
    }

    /// @notice Firmas ECDSA de `pks` ordenadas por dirección ascendente (lo exige Safe).
    function _sigs(bytes32 hash, uint256[] memory pks) internal pure returns (bytes memory out) {
        uint256 n = pks.length;
        address[] memory addrs = new address[](n);
        for (uint256 i; i < n; ++i) {
            addrs[i] = vm.addr(pks[i]);
        }
        for (uint256 i; i < n; ++i) {
            for (uint256 j = i + 1; j < n; ++j) {
                if (addrs[j] < addrs[i]) {
                    (addrs[i], addrs[j]) = (addrs[j], addrs[i]);
                    (pks[i], pks[j]) = (pks[j], pks[i]);
                }
            }
        }
        for (uint256 i; i < n; ++i) {
            out = bytes.concat(out, _ecdsa(pks[i], hash));
        }
    }

    function _pair(uint256 a, uint256 b) internal pure returns (uint256[] memory pks) {
        pks = new uint256[](2);
        pks[0] = a;
        pks[1] = b;
    }

    /// @notice Firma con `pks` y ejecuta desde `sender` con el nonce actual de la Safe.
    function _exec(ISafe safe, address sender, SafeTx memory t, uint256[] memory pks) internal returns (bool) {
        bytes memory sigs = _sigs(_txHash(safe, t, safe.nonce()), pks);
        return _execRaw(safe, sender, t, sigs);
    }

    function _execRaw(ISafe safe, address sender, SafeTx memory t, bytes memory sigs) internal returns (bool ok) {
        vm.prank(sender);
        ok = safe.execTransaction(
            t.to,
            t.value,
            t.data,
            t.operation,
            t.safeTxGas,
            t.baseGas,
            t.gasPrice,
            t.gasToken,
            payable(t.refundReceiver),
            sigs
        );
    }

    /// @notice Igual que `_exec` pero espera que la ejecución revierta con `err` (selector y argumentos).
    function _execExpectRevert(ISafe safe, address sender, SafeTx memory t, uint256[] memory pks, bytes memory err)
        internal
    {
        bytes memory sigs = _sigs(_txHash(safe, t, safe.nonce()), pks);
        vm.expectRevert(err);
        _execRaw(safe, sender, t, sigs);
    }
}
