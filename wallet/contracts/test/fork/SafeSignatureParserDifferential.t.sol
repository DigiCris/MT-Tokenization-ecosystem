// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {ForkTest} from "../utils/ForkTest.sol";
import {SafeHelpers} from "../utils/SafeHelpers.sol";
import {ISafe} from "../../src/interfaces/ISafe.sol";
import {SafeSignatureParser} from "../../src/libraries/SafeSignatureParser.sol";

contract DifferentialParserHarness {
    function signers(bytes32 hash, bytes memory sigs, uint256 threshold)
        external
        pure
        returns (address[] memory s, SafeSignatureParser.SigType[] memory t)
    {
        return SafeSignatureParser.thresholdSigners(hash, sigs, threshold);
    }
}

/// @notice P04.T02 — [C-PAR-02]: para blobs válidos, malformados y maliciosos, si `checkNSignatures` de la Safe real
///         acepta, el parser no revierte y devuelve exactamente los owners que la Safe validó, en orden (A7).
contract SafeSignatureParserDifferentialTest is ForkTest, SafeHelpers {
    DifferentialParserHarness internal parser;
    ISafe internal safe;
    uint256[3] internal pks;
    address[3] internal owners;
    bytes32 internal constant HASH = keccak256("differential-safe-tx-hash");

    function setUp() public {
        _fork();
        parser = new DifferentialParserHarness();
        address[] memory list = new address[](3);
        for (uint256 i; i < 3; ++i) {
            (owners[i], pks[i]) = makeAddrAndKey(string.concat("diff-owner-", vm.toString(i)));
            list[i] = owners[i];
        }
        safe = _deployPlainSafe(ext.safeProxyFactory, ext.safeL2Singleton, list, 2, 1);
    }

    function _sorted(uint256 a, uint256 b) internal view returns (uint256 lo, uint256 hi) {
        (lo, hi) = owners[a] < owners[b] ? (a, b) : (b, a);
    }

    /// Construye un blob según `mode` a partir de dos owners distintos (`i`, `j`) y basura `junk`.
    function _blob(uint8 mode, uint256 i, uint256 j, bytes memory junk)
        internal
        returns (bytes memory sigs, address executor)
    {
        (uint256 lo, uint256 hi) = _sorted(i, j);
        executor = address(0xE11E);
        if (mode == 0) {
            sigs = bytes.concat(_ecdsa(pks[lo], HASH), _ecdsa(pks[hi], HASH)); // válido
        } else if (mode == 1) {
            sigs = bytes.concat(_ecdsa(pks[hi], HASH), _ecdsa(pks[lo], HASH)); // desordenado
        } else if (mode == 2) {
            executor = owners[hi]; // v = 1 del ejecutor
            sigs = bytes.concat(_ecdsa(pks[lo], HASH), _approvedHashSig(owners[hi]));
        } else if (mode == 3) {
            vm.prank(owners[lo]); // hash aprobado on-chain
            safe.approveHash(HASH);
            sigs = bytes.concat(_approvedHashSig(owners[lo]), _ecdsa(pks[hi], HASH));
        } else if (mode == 4) {
            sigs = bytes.concat(_ethSign(pks[lo], HASH), _ethSign(pks[hi], HASH)); // eth_sign
        } else if (mode == 5) {
            sigs = junk.length >= 130 ? junk : bytes.concat(junk, new bytes(130 - junk.length)); // aleatorio
        } else if (mode == 6) {
            sigs = bytes.concat(_ecdsa(pks[lo], HASH), _ecdsa(pks[hi], HASH), junk); // bytes anexados
        } else if (mode == 7) {
            sigs = bytes.concat(
                abi.encodePacked(bytes32(uint256(uint160(owners[lo]))), bytes32(uint256(130)), uint8(0)),
                _ecdsa(pks[hi], HASH),
                abi.encode(uint256(0))
            );
        } else if (mode == 8) {
            (, uint256 strangerPk) = makeAddrAndKey("diff-stranger");
            sigs = bytes.concat(_ecdsa(pks[lo], HASH), _ecdsa(strangerPk, HASH)); // no owner
        } else {
            sigs = bytes.concat(_ecdsa(pks[lo], HASH), _ecdsa(pks[lo], HASH)); // duplicado
        }
    }

    function testFuzz_parserMatchesSafeAcceptance(uint8 mode, uint8 a, uint8 b, bytes memory junk) public {
        mode = uint8(bound(mode, 0, 9));
        uint256 i = bound(a, 0, 2);
        uint256 j = bound(b, 0, 2);
        if (i == j) j = (i + 1) % 3;
        (bytes memory sigs, address executor) = _blob(mode, i, j, junk);
        bool accepted;
        try safe.checkNSignatures(executor, HASH, sigs, 2) {
            accepted = true;
        } catch {}
        if (mode == 0 || mode == 2 || mode == 3 || mode == 4 || mode == 6) {
            assertTrue(accepted, "la Safe debia aceptar");
        }
        if (mode == 1 || mode == 7 || mode == 8 || mode == 9) assertFalse(accepted, "la Safe debia rechazar");
        if (!accepted) return;
        (address[] memory got,) = parser.signers(HASH, sigs, 2);
        (uint256 lo, uint256 hi) = _sorted(i, j);
        assertEq(got.length, 2);
        if (mode != 5) {
            assertEq(got[0], owners[lo]);
            assertEq(got[1], owners[hi]);
        }
        assertTrue(safe.isOwner(got[0]) && safe.isOwner(got[1]), "signers son owners");
        assertTrue(got[0] < got[1], "orden estrictamente creciente");
    }

    /// Con firmas válidas de cualquier par de owners, el parser recupera exactamente ese par.
    function testFuzz_validPairs(uint8 a, uint8 b) public {
        uint256 i = bound(a, 0, 2);
        uint256 j = bound(b, 0, 2);
        vm.assume(i != j);
        (bytes memory sigs,) = _blob(0, i, j, "");
        safe.checkNSignatures(address(this), HASH, sigs, 2);
        (address[] memory got, SafeSignatureParser.SigType[] memory types) = parser.signers(HASH, sigs, 2);
        (uint256 lo, uint256 hi) = _sorted(i, j);
        assertEq(got[0], owners[lo]);
        assertEq(got[1], owners[hi]);
        assertEq(uint8(types[0]), uint8(SafeSignatureParser.SigType.Ecdsa));
    }
}
