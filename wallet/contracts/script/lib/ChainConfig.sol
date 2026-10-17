// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";

/// @title ChainConfig
/// @notice Direcciones y codehashes externos verificados (`config/chains/base-mainnet.json`, P03) para scripts y
///         tests: una sola fuente de verdad, nunca valores repetidos en el código.
library ChainConfig {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    string internal constant PATH = "/../config/chains/base-mainnet.json";

    /// @notice Contratos externos y bloque de fork.
    struct External {
        uint256 chainId;
        uint256 forkBlock;
        bytes32 forkBlockHash;
        address safeSingleton;
        address safeL2Singleton;
        bytes32 safeL2SingletonCodehash;
        address safeProxyFactory;
        bytes32 safeProxyFactoryCodehash;
        bytes32 proxyCreationCodeHash;
        bytes32 proxyRuntimeCodehash;
        address multiSendCallOnly;
        address compatibilityFallbackHandler;
        address usdc;
        address usdt;
        address uniswapV3Factory;
        address uniswapV3Pool;
        address quoterV2;
        address permit2;
    }

    /// @notice Lee el JSON verificado del repositorio.
    function load() internal view returns (External memory e) {
        string memory json = VM.readFile(string.concat(VM.projectRoot(), PATH));
        e.chainId = VM.parseJsonUint(json, ".chainId");
        e.forkBlock = VM.parseJsonUint(json, ".fork.blockNumber");
        e.forkBlockHash = VM.parseJsonBytes32(json, ".fork.blockHash");
        e.safeSingleton = VM.parseJsonAddress(json, ".contracts.safeSingleton.address");
        e.safeL2Singleton = VM.parseJsonAddress(json, ".contracts.safeL2Singleton.address");
        e.safeL2SingletonCodehash = VM.parseJsonBytes32(json, ".contracts.safeL2Singleton.codehash");
        e.safeProxyFactory = VM.parseJsonAddress(json, ".contracts.safeProxyFactory.address");
        e.safeProxyFactoryCodehash = VM.parseJsonBytes32(json, ".contracts.safeProxyFactory.codehash");
        e.proxyCreationCodeHash = VM.parseJsonBytes32(json, ".contracts.safeProxyFactory.proxyCreationCodeHash");
        e.proxyRuntimeCodehash = VM.parseJsonBytes32(json, ".contracts.safeProxyFactory.proxyRuntimeCodehash");
        e.multiSendCallOnly = VM.parseJsonAddress(json, ".contracts.multiSendCallOnly.address");
        e.compatibilityFallbackHandler = VM.parseJsonAddress(json, ".contracts.compatibilityFallbackHandler.address");
        e.usdc = VM.parseJsonAddress(json, ".contracts.usdc.address");
        e.usdt = VM.parseJsonAddress(json, ".contracts.usdt.address");
        e.uniswapV3Factory = VM.parseJsonAddress(json, ".contracts.uniswapV3Factory.address");
        e.uniswapV3Pool = VM.parseJsonAddress(json, ".contracts.uniswapV3PoolUsdcUsdt100.address");
        e.quoterV2 = VM.parseJsonAddress(json, ".contracts.uniswapQuoterV2.address");
        e.permit2 = VM.parseJsonAddress(json, ".contracts.permit2.address");
    }

    /// @notice Nombres de todos los contratos externos del JSON (para recorrer address/codehash).
    function contractKeys() internal view returns (string[] memory) {
        string memory json = VM.readFile(string.concat(VM.projectRoot(), PATH));
        return VM.parseJsonKeys(json, ".contracts");
    }

    /// @notice `address` y `codehash` de un contrato externo por su clave en el JSON.
    function contractAt(string memory key) internal view returns (address addr, bytes32 codehash) {
        string memory json = VM.readFile(string.concat(VM.projectRoot(), PATH));
        addr = VM.parseJsonAddress(json, string.concat(".contracts.", key, ".address"));
        codehash = VM.parseJsonBytes32(json, string.concat(".contracts.", key, ".codehash"));
    }
}
