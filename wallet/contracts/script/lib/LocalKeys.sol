// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";

/// @title LocalKeys
/// @notice Cuentas determinísticas SÓLO para el fork local ([C-SCR-03]), derivadas de `LOCAL_SEED`: nunca las
///         cuentas públicas de Anvil. Cada derivación exige que el RPC del script sea Anvil
///         (`web3_clientVersion` = `anvil/…`), así una semilla local nunca firma en una red real.
/// @dev `clave(label) = keccak256("mtw-local-key" ‖ seed ‖ label)`, re-hasheada mientras no caiga en [1, n) de
///      secp256k1. Los labels en uso están en `docs/runbooks/deploy.md`.
library LocalKeys {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    /// @notice El RPC del script no es Anvil.
    error NotAnvil();
    /// @notice `LOCAL_SEED` falta o no es un hex de 32 bytes distinto de cero.
    error InvalidSeed();

    /// @notice true si el RPC del fork activo del script es Anvil.
    function isAnvil() internal returns (bool) {
        // `vm.rpc` devuelve el resultado ABI-encoded (un string JSON llega como `bytes`).
        try VM.rpc("web3_clientVersion", "[]") returns (bytes memory raw) {
            return raw.length >= 64 && _hasPrefix(abi.decode(raw, (bytes)), "anvil/");
        } catch {
            return false;
        }
    }

    /// @notice Clave privada local de `label` (revierte fuera de Anvil).
    function key(string memory label) internal returns (uint256 pk) {
        if (!isAnvil()) revert NotAnvil();
        pk = uint256(keccak256(abi.encodePacked("mtw-local-key", _seed(), label)));
        while (pk == 0 || pk >= SECP256K1_N) {
            pk = uint256(keccak256(abi.encodePacked(pk)));
        }
    }

    /// @notice Dirección local de `label`.
    function addr(string memory label) internal returns (address) {
        return VM.addr(key(label));
    }

    /// @notice Lleva el saldo de `account` a `amount` en Anvil (`anvil_setBalance`) y en la simulación del script,
    ///         si tiene menos.
    function fund(address account, uint256 amount) internal {
        if (!isAnvil()) revert NotAnvil();
        if (account.balance >= amount) return;
        VM.rpc("anvil_setBalance", string.concat('["', VM.toString(account), '","', VM.toString(bytes32(amount)), '"]'));
        VM.deal(account, amount);
    }

    function _seed() private view returns (bytes32 seed) {
        string memory raw = VM.envOr("LOCAL_SEED", string(""));
        uint256 len = bytes(raw).length;
        if (len == 64) raw = string.concat("0x", raw);
        else if (len != 66) revert InvalidSeed();
        seed = VM.parseBytes32(raw);
        if (seed == bytes32(0)) revert InvalidSeed();
    }

    function _hasPrefix(bytes memory value, bytes memory prefix) private pure returns (bool) {
        if (value.length < prefix.length) return false;
        for (uint256 i; i < prefix.length; ++i) {
            if (value[i] != prefix[i]) return false;
        }
        return true;
    }
}
