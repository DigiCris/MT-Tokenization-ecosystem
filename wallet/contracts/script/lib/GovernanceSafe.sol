// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {ChainConfig} from "./ChainConfig.sol";
import {ISafe, ISafeProxyFactory} from "../../src/interfaces/ISafe.sol";

/// @title GovernanceSafe
/// @notice Governance Safe (admin del `PolicyRegistry`): Safe v1.5.0 multisig sin guard, módulos ni fallback
///         handler, creada con la `SafeProxyFactory` canónica. Local: 2-de-3 con owners derivados de `LOCAL_SEED`;
///         ensayos de staging y producción: owners de `~/.config/mtw/<env>.env` (P25, P30).
library GovernanceSafe {
    /// @notice Threshold de la Governance Safe local.
    uint256 internal constant LOCAL_THRESHOLD = 2;
    /// @notice saltNonce de la Governance Safe local.
    uint256 internal constant LOCAL_SALT_NONCE = uint256(keccak256("mtw-local-governance-safe"));

    /// @notice `setup` sin guard, módulos, fallback handler ni pago.
    function initializer(address[] memory owners, uint256 threshold) internal pure returns (bytes memory) {
        return abi.encodeCall(
            ISafe.setup, (owners, threshold, address(0), "", address(0), address(0), 0, payable(address(0)))
        );
    }

    /// @notice Dirección CREATE2 de la Safe (misma derivación que `createProxyWithNonceL2` de Safe v1.5.0).
    function predict(ChainConfig.External memory ext, address[] memory owners, uint256 threshold, uint256 saltNonce)
        internal
        pure
        returns (address)
    {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer(owners, threshold)), saltNonce));
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                ISafeProxyFactory(ext.safeProxyFactory).proxyCreationCode(), uint256(uint160(ext.safeL2Singleton))
            )
        );
        return
            address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), ext.safeProxyFactory, salt, initCodeHash))))
            );
    }

    /// @notice Crea la Safe en el contexto de broadcast del llamador.
    function create(ChainConfig.External memory ext, address[] memory owners, uint256 threshold, uint256 saltNonce)
        internal
        returns (address)
    {
        return ISafeProxyFactory(ext.safeProxyFactory)
            .createProxyWithNonceL2(ext.safeL2Singleton, initializer(owners, threshold), saltNonce);
    }

    /// @notice 0 si `safe` sirve como admin: proxy canónico, singleton Safe o SafeL2 v1.5.0, threshold ≥ 2 y más
    ///         owners que el threshold (una clave perdida no bloquea la gobernanza); si no, el primer ítem que falla.
    function check(ChainConfig.External memory ext, address safe) internal view returns (bytes32) {
        if (safe.codehash != ext.proxyRuntimeCodehash) return "PROXY_CODEHASH";
        // Con un singleton que no es una Safe, `getStorageAt` revierte: cuenta como singleton incorrecto.
        try ISafe(safe).getStorageAt(0, 1) returns (bytes memory word) {
            // el slot 0 guarda la dirección del singleton alineada a la derecha.
            // forge-lint: disable-next-line(unsafe-typecast)
            address singleton = address(uint160(uint256(bytes32(word))));
            if (singleton != ext.safeL2Singleton && singleton != ext.safeSingleton) return "SINGLETON";
        } catch {
            return "SINGLETON";
        }
        uint256 threshold = ISafe(safe).getThreshold();
        if (threshold < 2) return "THRESHOLD";
        if (ISafe(safe).getOwners().length <= threshold) return "OWNERS";
        return bytes32(0);
    }
}
