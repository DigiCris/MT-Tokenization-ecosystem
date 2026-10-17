// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @notice Tipo de operación de una SafeTx. ABI-compatible con `Enum.Operation` de Safe v1.5.0 (`uint8`).
enum Operation {
    Call,
    DelegateCall
}

/// @title ISafe
/// @notice Subconjunto de la interfaz pública de Safe v1.5.0 (SafeL2) que usan los contratos del sistema.
/// @dev Firmas exactas de `safe-fndn/safe-smart-account` v1.5.0 (commit dc437e8); el test
///      `SafeInterfaceSelectorsTest` las contrasta con el código de la Safe desplegada en el fork (P04.T01).
interface ISafe {
    /// @notice Inicializa la Safe (sólo una vez). Ejecuta `to` por DELEGATECALL desde `setupModules`.
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    /// @notice Ejecuta una SafeTx firmada por `threshold` owners.
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool success);

    /// @notice Valida `requiredSignatures` firmas de owners sobre `dataHash` con el ejecutor `executor`.
    function checkNSignatures(address executor, bytes32 dataHash, bytes memory signatures, uint256 requiredSignatures)
        external
        view;

    /// @notice Hash EIP-712 de una SafeTx con un nonce dado.
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 _nonce
    ) external view returns (bytes32);

    function domainSeparator() external view returns (bytes32);
    function nonce() external view returns (uint256);
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
    function isOwner(address owner) external view returns (bool);
    function approvedHashes(address owner, bytes32 hash) external view returns (uint256);

    /// @notice Lee `length` palabras de storage desde el slot `offset` (no hay getters de guard/fallback).
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);

    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);

    function setGuard(address guard) external;
    function setModuleGuard(address moduleGuard) external;
    function swapOwner(address prevOwner, address oldOwner, address newOwner) external;
    function approveHash(bytes32 hashToApprove) external;
    function VERSION() external view returns (string memory);
}

/// @title ISafeProxyFactory
/// @notice Subconjunto de `SafeProxyFactory` v1.5.0.
interface ISafeProxyFactory {
    function proxyCreationCode() external pure returns (bytes memory);
    function createProxyWithNonceL2(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}
