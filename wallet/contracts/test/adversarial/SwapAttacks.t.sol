// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AdversarialBase} from "./AdversarialBase.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";
import {SwapExecutorV3} from "../../src/SwapExecutorV3.sol";
import {CallDecoder} from "../../src/libraries/CallDecoder.sol";

/// @notice Executor falso con la misma firma de `swap`: intenta cobrarse los tokens de quien lo llama.
contract FakeSwapExecutor {
    address internal immutable THIEF;

    constructor(address thief) {
        THIEF = thief;
    }

    function swap(address tokenIn, uint256 amountIn, uint256, uint256) external returns (uint256) {
        IERC20(tokenIn).transferFrom(msg.sender, THIEF, amountIn);
        return 0;
    }
}

/// @notice P07.T01.j — swap de token arbitrario, recipient arbitrario, calldata maliciosa y `minOut` bajo el piso
///         (A16): el swap sólo opera USDC↔USDT por el executor registrado, el resultado vuelve a la Safe y la calldata
///         se valida con longitud y encoding exactos.
contract SwapAttacksTest is AdversarialBase {
    address internal constant WETH = 0x4200000000000000000000000000000000000006;

    function _swap(address tokenIn, uint256 amountIn, uint256 minOut, uint256 deadline)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(SwapExecutorV3.swap, (tokenIn, amountIn, minOut, deadline));
    }

    function _approve(address spender, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.approve, (spender, amount));
    }

    function test_arbitraryTokenSwapFails() public {
        address ex = address(sys.swapExecutor);
        _deny(userPk, WETH, _approve(ex, 1e18), SecurityGuard.UnsupportedToken.selector);
        _deny(userPk, ex, _swap(WETH, 1e18, 1e18, block.timestamp), SecurityGuard.UnsupportedToken.selector);
        vm.expectRevert(SwapExecutorV3.UnsupportedToken.selector);
        sys.swapExecutor.tokenOutFor(WETH);
        _assertSafeUntouched();
    }

    /// El executor no tiene parámetro de recipient. Un swap directo contra el pool con recipient del atacante:
    /// en RESTRICTED lo frena el Guard (operación desconocida); en BOOTSTRAP el Guard lo deja pasar, pero el pool exige
    /// el pago por callback y la Safe no lo implementa, así que el pool revierte (`IIA`) y la Safe 1.5.0 propaga ese
    /// motivo.
    function test_arbitraryRecipientImpossible() public {
        bytes memory poolSwap = abi.encodeWithSignature(
            "swap(address,bool,int256,uint160,bytes)", attacker, true, int256(100e6), uint160(4_295_128_740), ""
        );
        if (restricted) {
            _deny(userPk, ext.uniswapV3Pool, poolSwap, SecurityGuard.OperationNotPermitted.selector);
        } else {
            _execExpectRevert(
                safe, executor, _call(ext.uniswapV3Pool, poolSwap), _pair(userPk, executorPk), bytes("IIA")
            );
        }
        assertEq(usdt.balanceOf(attacker), 0);
        _assertSafeUntouched();
        // Un swap legítimo acredita a la Safe y a nadie más.
        address ex = address(sys.swapExecutor);
        assertTrue(_assisted(userPk, ext.usdc, _approve(ex, 100e6)));
        assertTrue(_assisted(userPk, ex, _swap(ext.usdc, 100e6, 99.5e6, block.timestamp)));
        assertGe(usdt.balanceOf(address(safe)), SAFE_FUNDS + 99.5e6);
        assertEq(usdt.balanceOf(attacker), 0);
        assertEq(usdt.balanceOf(ex), 0);
    }

    /// Bytes extra, truncada y sólo selector.
    function test_maliciousSwapCalldataFails() public {
        address ex = address(sys.swapExecutor);
        bytes memory good = _swap(ext.usdc, 10e6, 9.95e6, block.timestamp + 1 hours);
        bytes4 malformed = CallDecoder.MalformedCalldata.selector;
        _deny(userPk, ex, bytes.concat(good, hex"00"), malformed);
        _deny(userPk, ex, bytes.concat(good, bytes32(uint256(uint160(attacker)))), malformed);
        bytes memory truncated = new bytes(good.length - 1);
        for (uint256 i; i < truncated.length; ++i) {
            truncated[i] = good[i];
        }
        _deny(userPk, ex, truncated, malformed);
        _deny(userPk, ex, abi.encodePacked(SwapExecutorV3.swap.selector), malformed);
        // Cualquier otra función del executor es administrativa para el Guard.
        _deny(
            userPk,
            ex,
            abi.encodeCall(SwapExecutorV3.uniswapV3SwapCallback, (int256(1), int256(0), "")),
            SecurityGuard.AdminCallForbidden.selector
        );
        _assertSafeUntouched();
    }

    function test_minOutDeadlineAndRoleRulesEnforced() public {
        address ex = address(sys.swapExecutor);
        assertTrue(_assisted(userPk, ext.usdc, _approve(ex, 100e6)));
        _deny(userPk, ex, _swap(ext.usdc, 100e6, 99.49e6, block.timestamp), SecurityGuard.MinOutBelowFloor.selector);
        _deny(userPk, ex, _swap(ext.usdc, 100e6, 0, block.timestamp), SecurityGuard.MinOutBelowFloor.selector);
        _deny(userPk, ex, _swap(ext.usdc, 100e6, 100e6, block.timestamp - 1), SecurityGuard.DeadlineExpired.selector);
        _deny(userPk, ex, _swap(ext.usdc, 0, 0, block.timestamp), SecurityGuard.ZeroAmount.selector);
        _deny(recoveryPk, ex, _swap(ext.usdc, 100e6, 99.5e6, block.timestamp), SecurityGuard.RoleNotAllowed.selector);
        _assertSafeUntouched();
    }

    /// Un executor no registrado no recibe approve y no puede cobrar: sin allowance, el `transferFrom` de USDC revierte
    /// (en BOOTSTRAP el Guard deja pasar la llamada desconocida y la Safe propaga el motivo del token).
    function test_unregisteredExecutorCannotTakeFunds() public {
        FakeSwapExecutor fake = new FakeSwapExecutor(attacker);
        _deny(userPk, ext.usdc, _approve(address(fake), 100e6), SecurityGuard.EconomicAuthorityDenied.selector);
        bytes memory call = _swap(ext.usdc, 100e6, 100e6, block.timestamp);
        if (restricted) {
            _deny(userPk, address(fake), call, SecurityGuard.OperationNotPermitted.selector);
        } else {
            _execExpectRevert(
                safe,
                executor,
                _call(address(fake), call),
                _pair(userPk, executorPk),
                bytes("ERC20: transfer amount exceeds allowance")
            );
        }
        assertEq(usdc.balanceOf(attacker), 0);
        _assertSafeUntouched();
    }
}
