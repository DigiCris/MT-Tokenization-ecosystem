// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @title SafeSignatureParser
/// @notice Espejo del parseo de firmas de `Safe.checkNSignatures` v1.5.0 ([C-PAR-01]): recupera los signers
///         y el tipo de firma de las primeras `threshold` firmas estáticas de 65 bytes (`r ‖ s ‖ v`).
/// @dev El Guard lo usa sólo después de que la Safe ya validó esas firmas (`checkSignatures` corre antes que
///      `checkTransaction`), así que nunca clasifica con firmas que la Safe rechazó. No lee bytes más allá de
///      lo que la Safe valida (no sigue los punteros dinámicos de las firmas de contrato). Validado por el
///      test diferencial [C-PAR-02] contra la Safe real del fork.
library SafeSignatureParser {
    /// @notice Tipo de firma según `v`, igual que Safe v1.5.0.
    enum SigType {
        Contract, // v == 0: firma de contrato (EIP-1271); owner = r
        ApprovedHash, // v == 1: hash aprobado o ejecutor == owner; owner = r
        EthSign, // v > 30: eth_sign (v - 4)
        Ecdsa // resto: ECDSA sobre el hash
    }

    /// @notice El blob de firmas es más corto que `threshold * 65` bytes.
    error SignaturesTooShort();
    /// @notice Una firma no recupera ningún signer.
    error InvalidSigner();

    /// @notice Signers y tipos de las primeras `threshold` firmas, en el orden del blob.
    function thresholdSigners(bytes32 dataHash, bytes memory signatures, uint256 threshold)
        internal
        pure
        returns (address[] memory signers, SigType[] memory types)
    {
        if (signatures.length < threshold * 65) revert SignaturesTooShort();
        signers = new address[](threshold);
        types = new SigType[](threshold);
        for (uint256 i; i < threshold; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = signatureSplit(signatures, i);
            address owner;
            if (v == 0) {
                owner = address(uint160(uint256(r)));
                types[i] = SigType.Contract;
            } else if (v == 1) {
                owner = address(uint160(uint256(r)));
                types[i] = SigType.ApprovedHash;
            } else if (v > 30) {
                bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", dataHash));
                // espejo de Safe 1.5.0, que no exige low-s; una firma maleable recupera el mismo signer.
                // forge-lint: disable-next-line(ecrecover)
                owner = ecrecover(ethSignedHash, v - 4, r, s);
                types[i] = SigType.EthSign;
            } else {
                // espejo de Safe 1.5.0, que no exige low-s; una firma maleable recupera el mismo signer.
                // forge-lint: disable-next-line(ecrecover)
                owner = ecrecover(dataHash, v, r, s);
                types[i] = SigType.Ecdsa;
            }
            // una firma inválida invalida todo el blob, igual que en Safe.
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (owner == address(0)) revert InvalidSigner();
            signers[i] = owner;
        }
    }

    /// @notice Lectura de la firma `pos` con el mismo layout que `SignatureDecoder.signatureSplit` de Safe v1.5.0.
    function signatureSplit(bytes memory signatures, uint256 pos)
        internal
        pure
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            let signaturePos := mul(0x41, pos)
            r := mload(add(signatures, add(signaturePos, 0x20)))
            s := mload(add(signatures, add(signaturePos, 0x40)))
            v := byte(0, mload(add(signatures, add(signaturePos, 0x60))))
        }
    }
}
