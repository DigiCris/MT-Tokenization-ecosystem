// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {ChainConfig} from "./lib/ChainConfig.sol";
import {QuoteReference} from "./lib/QuoteReference.sol";

/// @notice Cotización de referencia USDC↔USDT con QuoterV2 (P06.T04). Uso:
///         forge script script/QuoteReference.s.sol --rpc-url "$LOCAL_RPC_URL" --sig "run(uint256)" 1000000000
contract QuoteReferenceScript is Script {
    function run(uint256 amountIn) external {
        ChainConfig.External memory ext = ChainConfig.load();
        uint256 usdcToUsdt = QuoteReference.quote(ext.quoterV2, ext.usdc, ext.usdt, amountIn);
        uint256 usdtToUsdc = QuoteReference.quote(ext.quoterV2, ext.usdt, ext.usdc, amountIn);
        console2.log("amountIn (6 decimales)", amountIn);
        console2.log("USDC -> USDT", usdcToUsdt);
        console2.log("USDT -> USDC", usdtToUsdc);
    }
}
