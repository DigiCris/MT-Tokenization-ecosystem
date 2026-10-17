// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {SignatureDecoder} from "@safe-global/safe-smart-account/contracts/common/SignatureDecoder.sol";
import {SafeSignatureParser} from "../../src/libraries/SafeSignatureParser.sol";

/// @dev Expone el parser y, para el diferencial de layout, el `SignatureDecoder` original de Safe v1.5.0.
contract ParserHarness is SignatureDecoder {
    function thresholdSigners(bytes32 dataHash, bytes memory signatures, uint256 threshold)
        external
        pure
        returns (address[] memory, SafeSignatureParser.SigType[] memory)
    {
        return SafeSignatureParser.thresholdSigners(dataHash, signatures, threshold);
    }

    function ours(bytes memory signatures, uint256 pos) external pure returns (uint8, bytes32, bytes32) {
        return SafeSignatureParser.signatureSplit(signatures, pos);
    }

    function safes(bytes memory signatures, uint256 pos) external pure returns (uint8, bytes32, bytes32) {
        return signatureSplit(signatures, pos);
    }
}

/// @notice [C-PAR-01]: tipos de firma por `v`, sólo las primeras `threshold` firmas y mismo layout que Safe.
contract SafeSignatureParserTest is Test {
    ParserHarness internal h;
    bytes32 internal constant HASH = keccak256("safe-tx-hash");

    function setUp() public {
        h = new ParserHarness();
    }

    function _ecdsa(uint256 pk, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hash);
        return abi.encodePacked(r, s, v);
    }

    function test_ecdsa() public {
        (address a, uint256 pk) = makeAddrAndKey("ecdsa-signer");
        (address[] memory signers, SafeSignatureParser.SigType[] memory types) =
            h.thresholdSigners(HASH, _ecdsa(pk, HASH), 1);
        assertEq(signers[0], a);
        assertEq(uint8(types[0]), uint8(SafeSignatureParser.SigType.Ecdsa));
    }

    function test_ethSign() public {
        (address a, uint256 pk) = makeAddrAndKey("eth-sign-signer");
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", HASH)));
        (address[] memory signers, SafeSignatureParser.SigType[] memory types) =
            h.thresholdSigners(HASH, abi.encodePacked(r, s, v + 4), 1);
        assertEq(signers[0], a);
        assertEq(uint8(types[0]), uint8(SafeSignatureParser.SigType.EthSign));
    }

    function test_contractAndApprovedHash() public view {
        address owner = address(0xA11CE);
        bytes memory sigs = bytes.concat(
            abi.encodePacked(bytes32(uint256(uint160(owner))), bytes32(uint256(65)), uint8(0)),
            abi.encodePacked(bytes32(uint256(uint160(address(0xB0B)))), bytes32(0), uint8(1))
        );
        (address[] memory signers, SafeSignatureParser.SigType[] memory types) = h.thresholdSigners(HASH, sigs, 2);
        assertEq(signers[0], owner);
        assertEq(uint8(types[0]), uint8(SafeSignatureParser.SigType.Contract));
        assertEq(signers[1], address(0xB0B));
        assertEq(uint8(types[1]), uint8(SafeSignatureParser.SigType.ApprovedHash));
    }

    /// Sólo se leen las primeras `threshold` firmas; los bytes anexados se ignoran (A7).
    function test_onlyThresholdSignaturesAreRead() public {
        (address a, uint256 pk) = makeAddrAndKey("first");
        (, uint256 pk2) = makeAddrAndKey("appended");
        bytes memory sigs = bytes.concat(_ecdsa(pk, HASH), _ecdsa(pk2, HASH), hex"deadbeef");
        (address[] memory signers,) = h.thresholdSigners(HASH, sigs, 1);
        assertEq(signers.length, 1);
        assertEq(signers[0], a);
    }

    function test_tooShortReverts() public {
        vm.expectRevert(SafeSignatureParser.SignaturesTooShort.selector);
        h.thresholdSigners(HASH, new bytes(129), 2);
    }

    function test_zeroSignerReverts() public {
        // v = 27 con r = s = 0: ecrecover devuelve address(0).
        vm.expectRevert(SafeSignatureParser.InvalidSigner.selector);
        h.thresholdSigners(HASH, abi.encodePacked(bytes32(0), bytes32(0), uint8(27)), 1);
        // v = 0 con r = 0: owner address(0).
        vm.expectRevert(SafeSignatureParser.InvalidSigner.selector);
        h.thresholdSigners(HASH, abi.encodePacked(bytes32(0), bytes32(0), uint8(0)), 1);
    }

    /// Diferencial de layout contra `SignatureDecoder.signatureSplit` de Safe v1.5.0 (blob armado desde semillas:
    /// siempre alcanza la posición pedida, sin descartar entradas).
    function testFuzz_signatureSplitMatchesSafe(bytes32 seed, uint8 pos, uint8 extra) public view {
        uint256 p = bound(pos, 0, 8);
        uint256 len = (p + 1) * 65 + bound(extra, 0, 64);
        bytes memory sigs = new bytes(len);
        for (uint256 i; i < len; ++i) {
            sigs[i] = bytes1(uint8(uint256(keccak256(abi.encode(seed, i)))));
        }
        (uint8 v1, bytes32 r1, bytes32 s1) = h.ours(sigs, p);
        (uint8 v2, bytes32 r2, bytes32 s2) = h.safes(sigs, p);
        assertEq(v1, v2);
        assertEq(r1, r2);
        assertEq(s1, s2);
    }

    /// El tipo se decide sólo por `v`, igual que en `checkNSignatures`.
    function testFuzz_typeByV(bytes32 r, bytes32 s, uint8 v) public view {
        bytes memory sig = abi.encodePacked(r, s, v);
        try h.thresholdSigners(HASH, sig, 1) returns (
            address[] memory signers, SafeSignatureParser.SigType[] memory types
        ) {
            SafeSignatureParser.SigType expected = v == 0
                ? SafeSignatureParser.SigType.Contract
                : v == 1
                    ? SafeSignatureParser.SigType.ApprovedHash
                    : v > 30 ? SafeSignatureParser.SigType.EthSign : SafeSignatureParser.SigType.Ecdsa;
            assertEq(uint8(types[0]), uint8(expected));
            assertTrue(signers[0] != address(0));
        } catch (bytes memory err) {
            assertEq(bytes4(err), SafeSignatureParser.InvalidSigner.selector);
        }
    }
}
