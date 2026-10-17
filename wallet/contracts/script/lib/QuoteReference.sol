// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @notice Subconjunto de QuoterV2 de Uniswap v3 (periphery): cotiza por simulación (`eth_call`), no es `view`.
interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

/// @title QuoteReference
/// @notice Cotización de referencia con QuoterV2 sobre el pool canónico (fee 100) para validar `minOut` (P06.T04).
library QuoteReference {
    uint24 internal constant FEE = 100;

    /// @notice Salida esperada de un swap exact-input en el bloque actual.
    function quote(address quoter, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        returns (uint256 amountOut)
    {
        (amountOut,,,) = IQuoterV2(quoter)
            .quoteExactInputSingle(IQuoterV2.QuoteExactInputSingleParams(tokenIn, tokenOut, amountIn, FEE, 0));
    }

    /// @notice `minOut` para un slippage dado en bps sobre la cotización.
    function minOutFor(uint256 quoted, uint256 slippageBps) internal pure returns (uint256) {
        return quoted * (10_000 - slippageBps) / 10_000;
    }
}
