// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @title IWalletFactory
/// @notice Vistas de la `WalletFactory` que consulta el Guard ([C-FAC-06]).
interface IWalletFactory {
    function isCreating(address safe) external view returns (bool);
    function isWallet(address safe) external view returns (bool);
    function SAFE_BOOTSTRAP() external view returns (address);
}
