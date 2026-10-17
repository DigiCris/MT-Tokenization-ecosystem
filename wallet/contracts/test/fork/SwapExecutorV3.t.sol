// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ForkTest} from "../utils/ForkTest.sol";
import {SwapExecutorV3} from "../../src/SwapExecutorV3.sol";
import {QuoteReference} from "../../script/lib/QuoteReference.sol";

/// @dev Pool malicioso que se instala con `vm.etch` en la dirección del pool canónico (sólo dentro del test):
///      reentra en `swap` o llama al callback con un delta distinto del pedido.
contract MaliciousPool {
    SwapExecutorV3 internal immutable EXECUTOR;
    address internal immutable TOKEN;
    uint8 internal immutable MODE;

    constructor(SwapExecutorV3 executor, address token, uint8 mode) {
        EXECUTOR = executor;
        TOKEN = token;
        MODE = mode;
    }

    function swap(address, bool, int256 amountSpecified, uint160, bytes calldata) external returns (int256, int256) {
        if (MODE == 0) {
            EXECUTOR.swap(TOKEN, uint256(amountSpecified), uint256(amountSpecified), block.timestamp);
        } else if (MODE == 1) {
            EXECUTOR.uniswapV3SwapCallback(amountSpecified + 1, 0, "");
        } else if (MODE == 2) {
            // Cobra el delta correcto pero informa otro monto consumido.
            EXECUTOR.uniswapV3SwapCallback(amountSpecified, 0, "");
            return (0, 0);
        } else {
            // Cobra dos veces e informa el monto correcto.
            EXECUTOR.uniswapV3SwapCallback(amountSpecified, 0, "");
            EXECUTOR.uniswapV3SwapCallback(amountSpecified, 0, "");
            return (amountSpecified, 0);
        }
        return (0, 0);
    }
}

/// @notice P06.T01/T03 — [C-SWP-01..05], A15 y A16 contra el pool canónico USDC/USDT 0,01 % del fork.
contract SwapExecutorV3Test is ForkTest {
    SwapExecutorV3 internal ex;
    IERC20 internal usdc;
    IERC20 internal usdt;
    address internal trader;
    address internal attacker;

    event Swapped(
        address indexed account, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );

    function setUp() public {
        _fork();
        ex = new SwapExecutorV3(ext.usdc, ext.usdt, ext.uniswapV3Pool, ext.uniswapV3Factory);
        usdc = IERC20(ext.usdc);
        usdt = IERC20(ext.usdt);
        trader = makeAddr("trader");
        attacker = makeAddr("attacker");
        deal(ext.usdc, trader, 20_000e6);
        deal(ext.usdt, trader, 20_000e6);
    }

    function _swap(address tokenIn, uint256 amountIn, uint256 minOut) internal returns (uint256 out) {
        vm.startPrank(trader);
        IERC20(tokenIn).approve(address(ex), amountIn);
        out = ex.swap(tokenIn, amountIn, minOut, block.timestamp + 600);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------
    // [C-SWP-01] constructor e inmutables

    function test_immutables() public view {
        assertEq(ex.TOKEN0(), ext.usdc);
        assertEq(ex.TOKEN1(), ext.usdt);
        assertEq(ex.POOL(), ext.uniswapV3Pool);
        assertEq(ex.FACTORY(), ext.uniswapV3Factory);
        assertEq(ex.FEE(), 100);
        assertEq(ex.MAX_SLIPPAGE_BPS(), 50);
    }

    // Un constructor que revierte por test (forge coverage sólo atribuye el primero de cada test).
    function test_constructorRejectsUnknownPool() public {
        vm.expectRevert(SwapExecutorV3.PoolMismatch.selector);
        new SwapExecutorV3(ext.usdc, ext.usdt, makeAddr("otro-pool"), ext.uniswapV3Factory);
    }

    function test_constructorRejectsSwappedTokens() public {
        vm.expectRevert(SwapExecutorV3.PoolMismatch.selector);
        new SwapExecutorV3(ext.usdt, ext.usdc, ext.uniswapV3Pool, ext.uniswapV3Factory);
    }

    function test_constructorRejectsZeroToken() public {
        vm.expectRevert(SwapExecutorV3.ZeroAddress.selector);
        new SwapExecutorV3(address(0), ext.usdt, ext.uniswapV3Pool, ext.uniswapV3Factory);
    }

    function test_constructorRejectsZeroPool() public {
        vm.expectRevert(SwapExecutorV3.ZeroAddress.selector);
        new SwapExecutorV3(ext.usdc, ext.usdt, address(0), ext.uniswapV3Factory);
    }

    /// Decimales distintos (forzado: el pool canónico del set V1 tiene ambos tokens con 6 decimales).
    function test_constructorRejectsDecimalsMismatch() public {
        vm.mockCall(ext.usdt, abi.encodeWithSignature("decimals()"), abi.encode(uint8(18)));
        vm.expectRevert(SwapExecutorV3.DecimalsMismatch.selector);
        new SwapExecutorV3(ext.usdc, ext.usdt, ext.uniswapV3Pool, ext.uniswapV3Factory);
    }

    function test_tokenOutFor() public {
        assertEq(ex.tokenOutFor(ext.usdc), ext.usdt);
        assertEq(ex.tokenOutFor(ext.usdt), ext.usdc);
        vm.expectRevert(SwapExecutorV3.UnsupportedToken.selector);
        ex.tokenOutFor(makeAddr("otro-token"));
    }

    // ------------------------------------------------------------------------------------------
    // [C-SWP-02/03] swaps reales

    function test_swapUsdcToUsdt() public {
        uint256 quoted = QuoteReference.quote(ext.quoterV2, ext.usdc, ext.usdt, 1000e6);
        uint256 inBefore = usdc.balanceOf(trader);
        uint256 outBefore = usdt.balanceOf(trader);
        vm.prank(trader);
        usdc.approve(address(ex), 1000e6);
        vm.expectEmit(address(ex));
        emit Swapped(trader, ext.usdc, ext.usdt, 1000e6, quoted);
        vm.prank(trader);
        uint256 out = ex.swap(ext.usdc, 1000e6, 995e6, block.timestamp + 600);
        assertEq(out, quoted, "igual a la cotizacion de QuoterV2 en el mismo bloque");
        assertEq(inBefore - usdc.balanceOf(trader), 1000e6, "debito exacto");
        assertEq(usdt.balanceOf(trader) - outBefore, out);
        assertEq(usdc.allowance(trader, address(ex)), 0, "allowance final 0");
        assertEq(usdc.balanceOf(address(ex)), 0, "el executor no custodia");
        assertEq(usdt.balanceOf(address(ex)), 0, "el executor no custodia");
    }

    function test_swapUsdtToUsdc() public {
        uint256 quoted = QuoteReference.quote(ext.quoterV2, ext.usdt, ext.usdc, 2500e6);
        uint256 out = _swap(ext.usdt, 2500e6, QuoteReference.minOutFor(quoted, 10));
        assertEq(out, quoted);
        assertEq(usdt.allowance(trader, address(ex)), 0);
        assertEq(usdt.balanceOf(address(ex)), 0);
        assertEq(usdc.balanceOf(address(ex)), 0);
    }

    function test_swapValidations() public {
        vm.startPrank(trader);
        usdc.approve(address(ex), type(uint256).max);
        vm.expectRevert(SwapExecutorV3.UnsupportedToken.selector);
        ex.swap(makeAddr("token"), 1e6, 1e6, block.timestamp);
        vm.expectRevert(SwapExecutorV3.ZeroAmount.selector);
        ex.swap(ext.usdc, 0, 0, block.timestamp);
        vm.expectRevert(SwapExecutorV3.AmountTooLarge.selector);
        ex.swap(ext.usdc, uint256(type(int256).max) + 1, uint256(type(int256).max), block.timestamp);
        vm.expectRevert(SwapExecutorV3.DeadlineExpired.selector);
        ex.swap(ext.usdc, 1e6, 1e6, block.timestamp - 1);
        vm.expectRevert(SwapExecutorV3.MinOutBelowFloor.selector);
        ex.swap(ext.usdc, 1000e6, 994_999_999, block.timestamp);
        // minOut sobre el piso pero mayor a lo que entrega el pool → la salida real no alcanza.
        vm.expectRevert(SwapExecutorV3.InsufficientOutput.selector);
        ex.swap(ext.usdc, 1000e6, 1100e6, block.timestamp);
        vm.stopPrank();
    }

    /// Un monto que excede la liquidez del pool revierte sin mover fondos. El pool canónico tiene liquidez de
    /// rango completo: consume todo el input moviendo el precio y la salida no alcanza el piso (InsufficientOutput).
    /// Un fill parcial real (precio límite alcanzado) pediría un delta menor a amountIn y lo rechaza el callback
    /// (UnexpectedDelta, ver test_reentrancyAndWrongDeltaRejected).
    function test_amountAboveLiquidityReverts() public {
        deal(ext.usdc, trader, 50_000_000e6);
        vm.startPrank(trader);
        usdc.approve(address(ex), 50_000_000e6);
        vm.expectRevert(SwapExecutorV3.InsufficientOutput.selector);
        ex.swap(ext.usdc, 50_000_000e6, 49_750_000e6, block.timestamp);
        vm.stopPrank();
        assertEq(usdc.balanceOf(trader), 50_000_000e6);
        assertEq(usdc.allowance(trader, address(ex)), 50_000_000e6, "sin efectos: la tx entera revierte");
    }

    function test_callbackOnlyFromPoolDuringSwap() public {
        vm.expectRevert(SwapExecutorV3.UnauthorizedCallback.selector);
        ex.uniswapV3SwapCallback(1, 0, "");
        vm.prank(ext.uniswapV3Pool);
        vm.expectRevert(SwapExecutorV3.UnauthorizedCallback.selector);
        ex.uniswapV3SwapCallback(1, 0, "");
    }

    /// Reentrancia en swap y callback con un delta distinto: el pool canónico se reemplaza por uno malicioso.
    function test_reentrancyAndWrongDeltaRejected() public {
        vm.etch(ext.uniswapV3Pool, address(new MaliciousPool(ex, ext.usdc, 0)).code);
        vm.startPrank(trader);
        usdc.approve(address(ex), 10e6);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        ex.swap(ext.usdc, 10e6, 10e6, block.timestamp);
        vm.stopPrank();
        vm.etch(ext.uniswapV3Pool, address(new MaliciousPool(ex, ext.usdc, 1)).code);
        vm.prank(trader);
        vm.expectRevert(SwapExecutorV3.UnexpectedDelta.selector);
        ex.swap(ext.usdc, 10e6, 10e6, block.timestamp);
        assertEq(usdc.balanceOf(trader), 20_000e6);
    }

    /// El executor verifica lo que el pool informa y lo que efectivamente debitó (fill completo exacto).
    function test_inconsistentPoolResultsRejected() public {
        vm.etch(ext.uniswapV3Pool, address(new MaliciousPool(ex, ext.usdc, 2)).code);
        vm.startPrank(trader);
        usdc.approve(address(ex), 10e6);
        vm.expectRevert(SwapExecutorV3.PartialFill.selector);
        ex.swap(ext.usdc, 10e6, 10e6, block.timestamp);
        vm.stopPrank();
        vm.etch(ext.uniswapV3Pool, address(new MaliciousPool(ex, ext.usdc, 3)).code);
        vm.startPrank(trader);
        usdc.approve(address(ex), 20e6);
        vm.expectRevert(SwapExecutorV3.PartialFill.selector);
        ex.swap(ext.usdc, 10e6, 10e6, block.timestamp);
        vm.stopPrank();
        assertEq(usdc.balanceOf(trader), 20_000e6);
    }

    /// A15: una allowance residual de la Safe no la puede usar un tercero: quien llama `swap` paga con la suya y
    /// recibe él mismo (recipient = msg.sender por construcción).
    function test_residualAllowanceNotUsableByThirdParties() public {
        vm.prank(trader);
        usdc.approve(address(ex), 500e6);
        vm.prank(attacker);
        vm.expectRevert();
        ex.swap(ext.usdc, 500e6, 500e6, block.timestamp);
        assertEq(usdc.allowance(trader, address(ex)), 500e6);
        assertEq(usdc.balanceOf(trader), 20_000e6);
        deal(ext.usdc, attacker, 100e6);
        vm.startPrank(attacker);
        usdc.approve(address(ex), 100e6);
        uint256 out = ex.swap(ext.usdc, 100e6, 99_500_000, block.timestamp);
        vm.stopPrank();
        assertEq(usdt.balanceOf(attacker), out, "el atacante recibe en su propia cuenta");
        assertEq(usdc.balanceOf(trader), 20_000e6, "la cuenta con allowance residual no se toca");
    }

    /// P06.TST: montos de 1 a 10.000 tokens en ambos sentidos y slippage hasta 50 bps; la salida coincide con
    /// QuoterV2 y respeta minOut y el piso on-chain. Cada run ejecuta QuoterV2 y un swap real sobre el fork (~0,7 s):
    /// el perfil ci usa 500 runs en este test.
    /// forge-config: ci.fuzz.runs = 500
    function testFuzz_swapAmountsAndSlippage(uint256 amount, bool usdcIn, uint16 slippage) public {
        amount = bound(amount, 1e6, 10_000e6);
        uint256 slip = bound(slippage, 0, 50);
        (address tokenIn, address tokenOut) = usdcIn ? (ext.usdc, ext.usdt) : (ext.usdt, ext.usdc);
        uint256 quoted = QuoteReference.quote(ext.quoterV2, tokenIn, tokenOut, amount);
        uint256 floor = amount * 9950 / 10_000;
        uint256 minOut = QuoteReference.minOutFor(quoted, slip);
        if (minOut < floor) minOut = floor;
        if (quoted < floor) {
            vm.startPrank(trader);
            IERC20(tokenIn).approve(address(ex), amount);
            vm.expectRevert(SwapExecutorV3.InsufficientOutput.selector);
            ex.swap(tokenIn, amount, minOut, block.timestamp);
            vm.stopPrank();
            return;
        }
        uint256 out = _swap(tokenIn, amount, minOut);
        assertEq(out, quoted);
        assertGe(out, minOut);
        assertEq(IERC20(tokenIn).allowance(trader, address(ex)), 0);
        assertEq(IERC20(tokenIn).balanceOf(address(ex)), 0);
        assertEq(IERC20(tokenOut).balanceOf(address(ex)), 0);
    }
}
