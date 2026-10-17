// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ISwapExecutor} from "./interfaces/ISwapExecutor.sol";
import {
    IUniswapV3PoolMinimal,
    IUniswapV3FactoryMinimal,
    IUniswapV3SwapCallback
} from "./interfaces/IUniswapV3PoolMinimal.sol";

/// @title SwapExecutorV3
/// @notice Swap exact-input USDC ↔ USDT contra el pool canónico de Uniswap v3 (0,01 %) en Base ([C-SWP-01..05]).
/// @dev Inmutable, sin admin y sin custodia: el pool paga directo a `msg.sender` y el callback cobra con
///      `transferFrom(msg.sender, POOL, amountIn)`, que consume exactamente la allowance de la Safe. Payer y
///      recipient son siempre `msg.sender` (no son parámetros) y el único `transferFrom` posible tiene
///      `from == msg.sender` del `swap` en curso ([C-SWP-05]).
contract SwapExecutorV3 is ISwapExecutor, IUniswapV3SwapCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Fee tier del pool (0,01 %).
    uint24 public constant FEE = 100;
    /// @notice Slippage máximo admitido sobre `amountIn` (0,5 %).
    uint256 public constant MAX_SLIPPAGE_BPS = 50;
    /// @dev `TickMath.MIN_SQRT_RATIO + 1` y `TickMath.MAX_SQRT_RATIO - 1` de v3-core 1.0.1: límites de precio
    ///      extremos (el fill completo se exige aparte).
    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4_295_128_740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;

    /// @notice USDC (token0 del pool).
    address public immutable TOKEN0;
    /// @notice USDT (token1 del pool).
    address public immutable TOKEN1;
    /// @notice Pool canónico USDC/USDT fee 100.
    address public immutable POOL;
    /// @notice UniswapV3Factory que lo desplegó.
    address public immutable FACTORY;

    address private transient _payer;
    address private transient _tokenIn;
    uint256 private transient _amountIn;

    /// @notice Swap completado (payer = recipient = `account`).
    event Swapped(
        address indexed account, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );

    error PoolMismatch();
    error DecimalsMismatch();
    error UnsupportedToken();
    error ZeroAmount();
    error AmountTooLarge();
    error DeadlineExpired();
    error MinOutBelowFloor();
    error PartialFill();
    error InsufficientOutput();
    error UnauthorizedCallback();
    error UnexpectedDelta();
    error ZeroAddress();

    /// @param token0 USDC.
    /// @param token1 USDT.
    /// @param pool Pool USDC/USDT fee 100.
    /// @param factory UniswapV3Factory.
    constructor(address token0, address token1, address pool, address factory) {
        if (token0 == address(0) || token1 == address(0) || pool == address(0) || factory == address(0)) {
            revert ZeroAddress();
        }
        if (IUniswapV3FactoryMinimal(factory).getPool(token0, token1, FEE) != pool) revert PoolMismatch();
        IUniswapV3PoolMinimal p = IUniswapV3PoolMinimal(pool);
        if (p.token0() != token0 || p.token1() != token1 || p.fee() != FEE) revert PoolMismatch();
        if (IERC20Metadata(token0).decimals() != IERC20Metadata(token1).decimals()) revert DecimalsMismatch();
        TOKEN0 = token0;
        TOKEN1 = token1;
        POOL = pool;
        FACTORY = factory;
    }

    /// @inheritdoc ISwapExecutor
    function tokenOutFor(address tokenIn) public view returns (address) {
        if (tokenIn == TOKEN0) return TOKEN1;
        if (tokenIn == TOKEN1) return TOKEN0;
        revert UnsupportedToken();
    }

    /// @inheritdoc ISwapExecutor
    function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        address tokenOut = tokenOutFor(tokenIn);
        if (amountIn == 0) revert ZeroAmount();
        // type(int256).max es positivo: la conversión a uint256 es exacta.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (amountIn > uint256(type(int256).max)) revert AmountTooLarge();
        // solhint-disable-next-line not-rely-on-time
        // deadline de swap ([C-SWP-02]): comparar contra block.timestamp es la semántica pedida.
        // forge-lint: disable-next-line(block-timestamp)
        if (deadline < block.timestamp) revert DeadlineExpired();
        if (minAmountOut < amountIn * (10_000 - MAX_SLIPPAGE_BPS) / 10_000) revert MinOutBelowFloor();

        // Slither (reentrancy-balance): los saldos de msg.sender se miden antes y después a propósito (débito exacto y
        // crédito mínimo); swap es nonReentrant y durante la llamada sólo corren el pool canónico, USDC/USDT y el callback.
        // slither-disable-next-line reentrancy-balance
        uint256 inBefore = IERC20(tokenIn).balanceOf(msg.sender);
        // slither-disable-next-line reentrancy-balance
        uint256 outBefore = IERC20(tokenOut).balanceOf(msg.sender);
        bool zeroForOne = tokenIn == TOKEN0;
        uint160 sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE;
        _payer = msg.sender;
        // tokenOutFor ya restringió tokenIn a {TOKEN0, TOKEN1}.
        _tokenIn = zeroForOne ? TOKEN0 : TOKEN1;
        _amountIn = amountIn;
        (int256 amount0, int256 amount1) = IUniswapV3PoolMinimal(POOL)
            .swap(
                msg.sender,
                zeroForOne,
                // amountIn <= type(int256).max verificado arriba (AmountTooLarge).
                // forge-lint: disable-next-line(unsafe-typecast)
                int256(amountIn),
                sqrtPriceLimitX96,
                ""
            );
        // Slither (reentrancy-benign): limpieza del transient del swap en curso (también se borra al terminar la tx).
        // slither-disable-next-line reentrancy-benign
        _payer = address(0);
        _tokenIn = address(0);
        _amountIn = 0;

        // amountIn <= type(int256).max verificado arriba (AmountTooLarge).
        // forge-lint: disable-next-line(unsafe-typecast)
        if ((zeroForOne ? amount0 : amount1) != int256(amountIn)) revert PartialFill();
        // débito exacto exigido: tokens con fee-on-transfer no están soportados.
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (inBefore - IERC20(tokenIn).balanceOf(msg.sender) != amountIn) revert PartialFill();
        amountOut = IERC20(tokenOut).balanceOf(msg.sender) - outBefore;
        if (amountOut < minAmountOut) revert InsufficientOutput();
        // swap es nonReentrant y las llamadas previas son al pool canónico y a tokens soportados.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @inheritdoc IUniswapV3SwapCallback
    /// @dev Sólo el pool, con un swap en curso; paga exactamente el delta pedido, que debe ser `amountIn`.
    // Protegido: sólo el POOL canónico y sólo con un swap en curso (ver docs/security/semgrep-triage.md).
    // nosemgrep: solidity.security.uniswap-callback-not-protected.uniswap-callback-not-protected
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        address payer = _payer;
        if (msg.sender != POOL || payer == address(0)) revert UnauthorizedCallback();
        address tokenIn = _tokenIn;
        int256 delta = tokenIn == TOKEN0 ? amount0Delta : amount1Delta;
        // _amountIn <= type(int256).max (lo verificó swap antes de fijarlo).
        // forge-lint: disable-next-line(unsafe-typecast)
        if (delta != int256(_amountIn)) revert UnexpectedDelta();
        // Slither (arbitrary-send-erc20): payer es el msg.sender del swap en curso (transient) y el callback sólo lo acepta del POOL canónico ([C-SWP-03], [C-SWP-05]).
        // slither-disable-start arbitrary-send-erc20
        // delta == _amountIn > 0; payer es el msg.sender del swap en curso (transient, [C-SWP-03]/[C-SWP-05]).
        // forge-lint: disable-next-line(unsafe-typecast,arbitrary-send-erc20)
        IERC20(tokenIn).safeTransferFrom(payer, POOL, uint256(delta));
        // slither-disable-end arbitrary-send-erc20
    }
}
