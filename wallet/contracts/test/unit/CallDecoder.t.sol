// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC721} from "@openzeppelin/contracts/interfaces/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/interfaces/IERC1155.sol";
import {CallDecoder} from "../../src/libraries/CallDecoder.sol";
import {ISwapExecutor} from "../../src/interfaces/ISwapExecutor.sol";
import {IDestinationWhitelist} from "../../src/interfaces/IDestinationWhitelist.sol";
import {IRotationTimelock} from "../../src/interfaces/IRotationTimelock.sol";
import {ISafe} from "../../src/interfaces/ISafe.sol";

/// @dev Expone la librería interna para testearla con calldata arbitraria.
contract CallDecoderHarness {
    function selectorOf(bytes memory data) external pure returns (bytes4) {
        return CallDecoder.selectorOf(data);
    }

    function decodeAddressAmount(bytes memory data) external pure returns (address, uint256) {
        return CallDecoder.decodeAddressAmount(data);
    }

    function decodeSwap(bytes memory data) external pure returns (address, uint256, uint256, uint256) {
        return CallDecoder.decodeSwap(data);
    }

    function decodeAddress(bytes memory data) external pure returns (address) {
        return CallDecoder.decodeAddress(data);
    }

    function decodePropose(bytes memory data) external pure returns (uint8, address, address) {
        return CallDecoder.decodePropose(data);
    }

    function decodeBytes32(bytes memory data) external pure returns (bytes32) {
        return CallDecoder.decodeBytes32(data);
    }

    function decodeSwapOwner(bytes memory data) external pure returns (address, address, address) {
        return CallDecoder.decodeSwapOwner(data);
    }

    function tryDecodeSwapOwner(bytes memory data) external pure returns (bool, address, address) {
        return CallDecoder.tryDecodeSwapOwner(data);
    }

    function isEconomicAuthority(bytes4 selector) external pure returns (bool) {
        return CallDecoder.isEconomicAuthority(selector);
    }
}

/// @notice P04.T03 — [C-DEC-01..03]: longitudes exactas, encodings ambiguos y lista de autoridad económica.
contract CallDecoderTest is Test {
    CallDecoderHarness internal h;

    function setUp() public {
        h = new CallDecoderHarness();
    }

    // ------------------------------------------------------------------------------------------
    // [C-DEC-01] selectorOf

    function test_selectorOf_emptyIsZero() public view {
        assertEq(h.selectorOf(""), bytes4(0));
    }

    function test_selectorOf_partialSelectorReverts() public {
        for (uint256 n = 1; n < 4; ++n) {
            vm.expectRevert(CallDecoder.MalformedCalldata.selector);
            h.selectorOf(new bytes(n));
        }
    }

    function testFuzz_selectorOf(bytes calldata data) public view {
        vm.assume(data.length >= 4);
        assertEq(h.selectorOf(data), bytes4(data[:4]));
    }

    // ------------------------------------------------------------------------------------------
    // [C-DEC-02] decoders con longitud exacta

    function test_selectorConstantsMatchInterfaces() public pure {
        assertEq(CallDecoder.TRANSFER, IERC20.transfer.selector);
        assertEq(CallDecoder.APPROVE, IERC20.approve.selector);
        assertEq(CallDecoder.SWAP, ISwapExecutor.swap.selector);
        assertEq(CallDecoder.ADD_DESTINATION, IDestinationWhitelist.addDestination.selector);
        assertEq(CallDecoder.REMOVE_DESTINATION, IDestinationWhitelist.removeDestination.selector);
        assertEq(CallDecoder.PROPOSE, IRotationTimelock.propose.selector);
        assertEq(CallDecoder.CANCEL, IRotationTimelock.cancel.selector);
        assertEq(CallDecoder.SWAP_OWNER, ISafe.swapOwner.selector);
        assertEq(CallDecoder.SET_GUARD, ISafe.setGuard.selector);
        assertEq(CallDecoder.SET_MODULE_GUARD, ISafe.setModuleGuard.selector);
    }

    function test_decodeAddressAmount() public view {
        (address a, uint256 v) = h.decodeAddressAmount(abi.encodeCall(IERC20.transfer, (address(0xBEEF), 123)));
        assertEq(a, address(0xBEEF));
        assertEq(v, 123);
    }

    function test_decodeSwap() public view {
        (address t, uint256 a, uint256 m, uint256 d) =
            h.decodeSwap(abi.encodeCall(ISwapExecutor.swap, (address(0xC0FFEE), 10, 9, 77)));
        assertEq(t, address(0xC0FFEE));
        assertEq(a, 10);
        assertEq(m, 9);
        assertEq(d, 77);
    }

    function test_decodePropose_andOthers() public view {
        (uint8 k, address o, address n) =
            h.decodePropose(abi.encodeCall(IRotationTimelock.propose, (uint8(2), address(1), address(2))));
        assertEq(k, 2);
        assertEq(o, address(1));
        assertEq(n, address(2));
        assertEq(h.decodeAddress(abi.encodeCall(IDestinationWhitelist.addDestination, (address(7)))), address(7));
        assertEq(h.decodeBytes32(abi.encodeCall(IRotationTimelock.cancel, (bytes32(uint256(5))))), bytes32(uint256(5)));
        (address p, address oldO, address newO) =
            h.decodeSwapOwner(abi.encodeCall(ISafe.swapOwner, (address(1), address(2), address(3))));
        assertEq(p, address(1));
        assertEq(oldO, address(2));
        assertEq(newO, address(3));
    }

    /// Bytes extra o truncados → MalformedCalldata en cada decoder.
    function test_exactLengths_extraOrTruncatedReverts() public {
        bytes[7] memory valid = [
            abi.encodeCall(IERC20.transfer, (address(1), 1)),
            abi.encodeCall(ISwapExecutor.swap, (address(1), 1, 1, 1)),
            abi.encodeCall(IDestinationWhitelist.addDestination, (address(1))),
            abi.encodeCall(IRotationTimelock.propose, (uint8(0), address(1), address(2))),
            abi.encodeCall(IRotationTimelock.cancel, (bytes32(0))),
            abi.encodeCall(ISafe.swapOwner, (address(1), address(2), address(3))),
            abi.encodeCall(IERC20.approve, (address(1), 1))
        ];
        uint256[7] memory lengths = [uint256(68), 132, 36, 100, 36, 100, 68];
        for (uint256 i; i < valid.length; ++i) {
            assertEq(valid[i].length, lengths[i]);
            bytes memory extra = bytes.concat(valid[i], hex"00");
            bytes memory truncated = new bytes(valid[i].length - 1);
            for (uint256 j; j < truncated.length; ++j) {
                truncated[j] = valid[i][j];
            }
            _expectMalformed(i, extra);
            _expectMalformed(i, truncated);
        }
    }

    /// Bits altos en una dirección o un uint8 → abi.decode revierte (encoding ambiguo).
    function test_dirtyHighBitsRevert() public {
        bytes memory transfer = abi.encodeWithSelector(IERC20.transfer.selector, uint256(1) << 160 | 0xBEEF, 1);
        vm.expectRevert();
        h.decodeAddressAmount(transfer);
        bytes memory propose =
            abi.encodeWithSelector(IRotationTimelock.propose.selector, uint256(256), address(1), address(2));
        vm.expectRevert();
        h.decodePropose(propose);
    }

    function testFuzz_decodersRejectWrongLength(bytes calldata data) public {
        if (data.length != 68) {
            vm.expectRevert(CallDecoder.MalformedCalldata.selector);
            h.decodeAddressAmount(data);
        }
        if (data.length != 132) {
            vm.expectRevert(CallDecoder.MalformedCalldata.selector);
            h.decodeSwap(data);
        }
        if (data.length != 36) {
            vm.expectRevert(CallDecoder.MalformedCalldata.selector);
            h.decodeAddress(data);
        }
        if (data.length != 100) {
            vm.expectRevert(CallDecoder.MalformedCalldata.selector);
            h.decodeSwapOwner(data);
        }
    }

    // ------------------------------------------------------------------------------------------
    // tryDecodeSwapOwner (camino soberano: nunca revierte)

    function test_tryDecodeSwapOwner() public view {
        (bool ok, address o, address n) =
            h.tryDecodeSwapOwner(abi.encodeCall(ISafe.swapOwner, (address(1), address(0xA), address(0xB))));
        assertTrue(ok);
        assertEq(o, address(0xA));
        assertEq(n, address(0xB));
        (ok,,) = h.tryDecodeSwapOwner(abi.encodeCall(ISafe.setGuard, (address(1))));
        assertFalse(ok);
        (ok,,) = h.tryDecodeSwapOwner(
            abi.encodeWithSelector(ISafe.swapOwner.selector, address(1), uint256(1) << 200, address(0xB))
        );
        assertFalse(ok);
        (ok,,) = h.tryDecodeSwapOwner(
            bytes.concat(abi.encodeCall(ISafe.swapOwner, (address(1), address(0xA), address(0xB))), hex"00")
        );
        assertFalse(ok);
    }

    function testFuzz_tryDecodeSwapOwnerNeverReverts(bytes calldata data) public view {
        h.tryDecodeSwapOwner(data);
    }

    // ------------------------------------------------------------------------------------------
    // [C-DEC-03] autoridad económica: recorrido parametrizado de cada selector de la lista

    function test_everyEconomicAuthoritySelectorIsDenied() public view {
        bytes4[24] memory denied = [
            // ERC-20 extendido
            bytes4(keccak256("increaseAllowance(address,uint256)")),
            bytes4(keccak256("decreaseAllowance(address,uint256)")),
            IERC20.transferFrom.selector,
            // EIP-2612 (OpenZeppelin) y variantes de USDC v2.2 y DAI
            IERC20Permit.permit.selector,
            bytes4(keccak256("permit(address,address,uint256,uint256,bytes)")),
            bytes4(keccak256("permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)")),
            // ERC-721 / ERC-1155
            IERC721.setApprovalForAll.selector,
            bytes4(keccak256("safeTransferFrom(address,address,uint256)")),
            bytes4(keccak256("safeTransferFrom(address,address,uint256,bytes)")),
            IERC1155.safeTransferFrom.selector,
            IERC1155.safeBatchTransferFrom.selector,
            // ERC-777
            bytes4(keccak256("authorizeOperator(address)")),
            bytes4(keccak256("send(address,uint256,bytes)")),
            bytes4(keccak256("operatorSend(address,address,uint256,bytes,bytes)")),
            // EIP-3009 (y variantes con firma `bytes` de USDC v2.2)
            bytes4(
                keccak256(
                    "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"
                )
            ),
            bytes4(keccak256("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)")),
            bytes4(
                keccak256(
                    "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"
                )
            ),
            bytes4(keccak256("receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)")),
            // ERC-1363 / ERC-677
            bytes4(keccak256("transferAndCall(address,uint256)")),
            bytes4(keccak256("transferAndCall(address,uint256,bytes)")),
            bytes4(keccak256("transferFromAndCall(address,address,uint256)")),
            bytes4(keccak256("transferFromAndCall(address,address,uint256,bytes)")),
            bytes4(keccak256("approveAndCall(address,uint256)")),
            bytes4(keccak256("approveAndCall(address,uint256,bytes)"))
        ];
        for (uint256 i; i < denied.length; ++i) {
            assertTrue(h.isEconomicAuthority(denied[i]), vm.toString(abi.encodePacked(denied[i])));
        }
        assertEq(IERC721.setApprovalForAll.selector, IERC1155.setApprovalForAll.selector);
    }

    function test_typedSelectorsAreNotEconomicAuthority() public view {
        assertFalse(h.isEconomicAuthority(IERC20.transfer.selector));
        assertFalse(h.isEconomicAuthority(IERC20.approve.selector)); // regla propia [C-GRD-07]
        assertFalse(h.isEconomicAuthority(ISwapExecutor.swap.selector));
        assertFalse(h.isEconomicAuthority(bytes4(0)));
    }

    function _expectMalformed(uint256 i, bytes memory data) private {
        vm.expectRevert(CallDecoder.MalformedCalldata.selector);
        if (i == 0 || i == 6) h.decodeAddressAmount(data);
        else if (i == 1) h.decodeSwap(data);
        else if (i == 2) h.decodeAddress(data);
        else if (i == 3) h.decodePropose(data);
        else if (i == 4) h.decodeBytes32(data);
        else h.decodeSwapOwner(data);
    }
}
