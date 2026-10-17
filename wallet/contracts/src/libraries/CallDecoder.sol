// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @title CallDecoder
/// @notice Decodificación estricta de calldata para el camino asistido ([C-DEC-01..03]).
/// @dev Opera sobre `bytes memory` porque el Guard recibe `data` en memoria (con `calldata`, el decoder ABI de
///      `checkTransaction` excede la pila sin `via_ir`). Cada decoder exige la longitud exacta del encoding ABI
///      estándar (sin bytes extra ni truncados) y `abi.decode` revierte si una dirección o un `uint8` traen bits
///      altos no nulos (encoding ambiguo).
library CallDecoder {
    /// @notice Calldata con longitud distinta a la esperada o con un selector parcial.
    error MalformedCalldata();

    // Selectores tipificados del sistema: `bytes4(keccak256(firma))` toma a propósito los 4 primeros bytes.
    // forge-lint: disable-start(unsafe-typecast)
    bytes4 internal constant TRANSFER = bytes4(keccak256("transfer(address,uint256)")); // 0xa9059cbb
    bytes4 internal constant APPROVE = bytes4(keccak256("approve(address,uint256)")); // 0x095ea7b3
    bytes4 internal constant SWAP = bytes4(keccak256("swap(address,uint256,uint256,uint256)"));
    bytes4 internal constant ADD_DESTINATION = bytes4(keccak256("addDestination(address)"));
    bytes4 internal constant REMOVE_DESTINATION = bytes4(keccak256("removeDestination(address)"));
    bytes4 internal constant PROPOSE = bytes4(keccak256("propose(uint8,address,address)"));
    bytes4 internal constant CANCEL = bytes4(keccak256("cancel(bytes32)"));
    bytes4 internal constant SWAP_OWNER = bytes4(keccak256("swapOwner(address,address,address)"));
    bytes4 internal constant SET_GUARD = bytes4(keccak256("setGuard(address)"));
    bytes4 internal constant SET_MODULE_GUARD = bytes4(keccak256("setModuleGuard(address)"));

    // forge-lint: disable-end(unsafe-typecast)

    /// @notice Selector de `data`: `bytes4(0)` si está vacío; revierte si `0 < length < 4` ([C-DEC-01]).
    function selectorOf(bytes memory data) internal pure returns (bytes4) {
        if (data.length == 0) return bytes4(0);
        if (data.length < 4) revert MalformedCalldata();
        // los primeros 4 bytes de `data` son el selector (longitud ≥ 4 verificada).
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes4(data);
    }

    /// @notice `transfer(address,uint256)` / `approve(address,uint256)` (68 bytes).
    function decodeAddressAmount(bytes memory data) internal pure returns (address account, uint256 amount) {
        (account, amount) = abi.decode(_args(data, 68), (address, uint256));
    }

    /// @notice `swap(address,uint256,uint256,uint256)` (132 bytes).
    function decodeSwap(bytes memory data)
        internal
        pure
        returns (address tokenIn, uint256 amountIn, uint256 minAmountOut, uint256 deadline)
    {
        (tokenIn, amountIn, minAmountOut, deadline) = abi.decode(_args(data, 132), (address, uint256, uint256, uint256));
    }

    /// @notice `addDestination(address)` / `removeDestination(address)` / `setGuard(address)` /
    ///         `setModuleGuard(address)` (36 bytes).
    function decodeAddress(bytes memory data) internal pure returns (address account) {
        account = abi.decode(_args(data, 36), (address));
    }

    /// @notice `propose(uint8,address,address)` (100 bytes).
    function decodePropose(bytes memory data) internal pure returns (uint8 kind, address oldValue, address newValue) {
        (kind, oldValue, newValue) = abi.decode(_args(data, 100), (uint8, address, address));
    }

    /// @notice `cancel(bytes32)` (36 bytes).
    function decodeBytes32(bytes memory data) internal pure returns (bytes32 value) {
        value = abi.decode(_args(data, 36), (bytes32));
    }

    /// @notice `swapOwner(address,address,address)` (100 bytes).
    function decodeSwapOwner(bytes memory data)
        internal
        pure
        returns (address prev, address oldOwner, address newOwner)
    {
        (prev, oldOwner, newOwner) = abi.decode(_args(data, 100), (address, address, address));
    }

    /// @notice Variante que nunca revierte, para el camino soberano: devuelve `ok = false` si `data` no es
    ///         exactamente un `swapOwner` con direcciones bien codificadas.
    function tryDecodeSwapOwner(bytes memory data) internal pure returns (bool ok, address oldOwner, address newOwner) {
        // los primeros 4 bytes de `data` son el selector.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (data.length != 100 || bytes4(data) != SWAP_OWNER) return (false, address(0), address(0));
        uint256 w1;
        uint256 w2;
        // Palabras 2 y 3 de los argumentos: bytes 36..67 y 68..99 de `data` (más 32 de la longitud).
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            w1 := mload(add(data, 0x44))
            w2 := mload(add(data, 0x64))
        }
        if (w1 >> 160 != 0 || w2 >> 160 != 0) return (false, address(0), address(0));
        // los 96 bits altos de w1 y w2 son cero (verificado arriba): la conversión es exacta.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (true, address(uint160(w1)), address(uint160(w2)));
    }

    /// @dev Copia los argumentos (todo salvo el selector) tras exigir la longitud exacta del encoding.
    function _args(bytes memory data, uint256 expectedLength) private pure returns (bytes memory args) {
        if (data.length != expectedLength) revert MalformedCalldata();
        uint256 argsLength = expectedLength - 4;
        args = new bytes(argsLength);
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            mcopy(add(args, 0x20), add(data, 0x24), argsLength)
        }
    }

    /// @notice Selectores de autoridad económica siempre denegados en el camino asistido ([C-DEC-03], [C-GRD-08]).
    /// @dev `approve` no está en la lista: tiene su propia regla ([C-GRD-07]). Incluye las variantes con
    ///      firma `bytes` que implementa USDC v2.2 (EIP-2612/EIP-3009) y la familia ERC-1363.
    // `bytes4(keccak256(firma))` toma a propósito los 4 primeros bytes.
    // forge-lint: disable-next-item(unsafe-typecast)
    function isEconomicAuthority(bytes4 selector) internal pure returns (bool) {
        return selector == bytes4(keccak256("increaseAllowance(address,uint256)"))
            || selector == bytes4(keccak256("decreaseAllowance(address,uint256)"))
            || selector == bytes4(keccak256("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)")) // EIP-2612
            || selector == bytes4(keccak256("permit(address,address,uint256,uint256,bytes)")) // EIP-2612 (USDC, firma bytes)
            || selector == bytes4(keccak256("permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)")) // DAI
            || selector == bytes4(keccak256("setApprovalForAll(address,bool)"))
            || selector == bytes4(keccak256("transferFrom(address,address,uint256)"))
            || selector == bytes4(keccak256("authorizeOperator(address)")) // ERC-777
            || selector == bytes4(keccak256("send(address,uint256,bytes)")) // ERC-777
            || selector == bytes4(keccak256("operatorSend(address,address,uint256,bytes,bytes)")) // ERC-777
            || selector
                == bytes4(
                keccak256(
                "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"
            )
            )
            || selector
                == bytes4(keccak256("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)"))
            || selector
                == bytes4(
                keccak256(
                "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"
            )
            )
            || selector
                == bytes4(keccak256("receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)"))
            || selector == bytes4(keccak256("transferAndCall(address,uint256)")) // ERC-1363
            || selector == bytes4(keccak256("transferAndCall(address,uint256,bytes)")) // ERC-1363 / ERC-677
            || selector == bytes4(keccak256("transferFromAndCall(address,address,uint256)")) // ERC-1363
            || selector == bytes4(keccak256("transferFromAndCall(address,address,uint256,bytes)")) // ERC-1363
            || selector == bytes4(keccak256("approveAndCall(address,uint256)")) // ERC-1363
            || selector == bytes4(keccak256("approveAndCall(address,uint256,bytes)")) // ERC-1363
            || selector == bytes4(keccak256("safeTransferFrom(address,address,uint256)")) // ERC-721
            || selector == bytes4(keccak256("safeTransferFrom(address,address,uint256,bytes)")) // ERC-721
            || selector == bytes4(keccak256("safeTransferFrom(address,address,uint256,uint256,bytes)")) // ERC-1155
            || selector == bytes4(keccak256("safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)")); // ERC-1155
    }
}
