// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ForkTest} from "../utils/ForkTest.sol";
import {SwapExecutorV3} from "../../src/SwapExecutorV3.sol";
import {QuoteReference} from "../../script/lib/QuoteReference.sol";

/// @notice P06.T04 / P06.MAN: la cotización de referencia de QuoterV2 coincide con el resultado real del swap en el
///         mismo bloque y respeta el piso on-chain para montos de 1 a 10.000 tokens.
contract QuoteReferenceTest is ForkTest {
    SwapExecutorV3 internal ex;

    function setUp() public {
        _fork();
        ex = new SwapExecutorV3(ext.usdc, ext.usdt, ext.uniswapV3Pool, ext.uniswapV3Factory);
    }

    function _check(address tokenIn, address tokenOut, uint256 amount) internal {
        // el deadline se usa antes de revertToState, que sólo restaura el estado del mismo bloque.
        // forge-lint: disable-next-line(environment-read-across-mutation)
        uint256 deadline = block.timestamp;
        uint256 snap = vm.snapshotState();
        uint256 quoted = QuoteReference.quote(ext.quoterV2, tokenIn, tokenOut, amount);
        address trader = makeAddr("quote-trader");
        deal(tokenIn, trader, amount);
        vm.startPrank(trader);
        IERC20(tokenIn).approve(address(ex), amount);
        uint256 out = ex.swap(tokenIn, amount, amount * 9950 / 10_000, deadline);
        vm.stopPrank();
        assertEq(out, quoted, "swap real == QuoterV2 en el mismo bloque");
        assertGe(out, amount * 9950 / 10_000, "por encima del piso de 0,5 %");
        vm.revertToState(snap);
    }

    function test_quoteMatchesSwapBothDirections() public {
        uint256[4] memory amounts = [uint256(1e6), 100e6, 1000e6, 10_000e6];
        for (uint256 i; i < amounts.length; ++i) {
            _check(ext.usdc, ext.usdt, amounts[i]);
            _check(ext.usdt, ext.usdc, amounts[i]);
        }
    }

    function test_minOutFor() public pure {
        assertEq(QuoteReference.minOutFor(1000e6, 30), 997e6);
        assertEq(QuoteReference.minOutFor(1000e6, 0), 1000e6);
    }
}
