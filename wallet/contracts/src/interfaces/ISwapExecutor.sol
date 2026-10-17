// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @title ISwapExecutor
/// @notice ABI común de todo swap executor registrable ([C-SWP-05]): paga y recibe siempre `msg.sender`.
interface ISwapExecutor {
    function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut, uint256 deadline)
        external
        returns (uint256 amountOut);
    function tokenOutFor(address tokenIn) external view returns (address tokenOut);
}
