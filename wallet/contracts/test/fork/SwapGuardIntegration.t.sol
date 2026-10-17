// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SystemFixture} from "../utils/SystemFixture.sol";
import {ISafe} from "../../src/interfaces/ISafe.sol";
import {ISwapExecutor} from "../../src/interfaces/ISwapExecutor.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";
import {SwapExecutorV3} from "../../src/SwapExecutorV3.sol";
import {PolicyRegistry} from "../../src/PolicyRegistry.sol";
import {QuoteReference} from "../../script/lib/QuoteReference.sol";

/// @dev Executors adversariales (sólo registrables por el admin en BOOTSTRAP) para probar que las post-condiciones
///      del Guard ([C-GRD-09]) son independientes del executor: MODE 0 cobra el doble, 1 paga menos que minOut,
///      2 cobra la mitad y deja allowance residual.
contract AdversarialExecutor is ISwapExecutor {
    address internal immutable USDC;
    address internal immutable USDT;
    uint8 internal immutable MODE;

    constructor(address usdc, address usdt, uint8 mode) {
        USDC = usdc;
        USDT = usdt;
        MODE = mode;
    }

    function tokenOutFor(address tokenIn) public view returns (address) {
        return tokenIn == USDC ? USDT : USDC;
    }

    function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut, uint256) external returns (uint256 out) {
        uint256 pull = MODE == 0 ? amountIn * 2 : MODE == 2 ? amountIn / 2 : amountIn;
        IERC20(tokenIn).transferFrom(msg.sender, address(this), pull);
        out = MODE == 1 ? minAmountOut - 1 : minAmountOut;
        IERC20(tokenOutFor(tokenIn)).transfer(msg.sender, out);
    }
}

/// @notice P06.T02 — integración del executor con el Guard ([C-GRD-07], [C-GRD-09]) y A15/A16 por la Safe real.
contract SwapGuardIntegrationTest is SystemFixture {
    IERC20 internal usdc;
    IERC20 internal usdt;

    function setUp() public {
        _setUpSystem();
        usdc = IERC20(ext.usdc);
        usdt = IERC20(ext.usdt);
        _fund(ext.usdc, address(safe), 5000e6);
    }

    function _assisted(uint256 cosignerPk, address to, bytes memory data) internal returns (bool) {
        return _exec(safe, executor, _call(to, data), _pair(cosignerPk, executorPk));
    }

    function _deny(uint256 cosignerPk, address to, bytes memory data, bytes4 err) internal {
        _execExpectRevert(safe, executor, _call(to, data), _pair(cosignerPk, executorPk), abi.encodeWithSelector(err));
    }

    function _swapData(address tokenIn, uint256 amountIn, uint256 minOut, uint256 deadline)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(ISwapExecutor.swap, (tokenIn, amountIn, minOut, deadline));
    }

    /// Approve exacto (nonce N) + swap (nonce N+1), firmados U+S: saldos verificados y allowance final 0 (A15).
    function test_approveThenSwapThroughSafe() public {
        address ex = address(sys.swapExecutor);
        uint256 quoted = QuoteReference.quote(ext.quoterV2, ext.usdc, ext.usdt, 1000e6);
        assertTrue(_assisted(userPk, ext.usdc, abi.encodeCall(IERC20.approve, (ex, 1000e6))));
        assertTrue(
            _assisted(
                userPk, ex, _swapData(ext.usdc, 1000e6, QuoteReference.minOutFor(quoted, 30), block.timestamp + 600)
            )
        );
        assertEq(usdc.balanceOf(address(safe)), 4000e6);
        assertEq(usdt.balanceOf(address(safe)), quoted);
        assertEq(usdc.allowance(address(safe), ex), 0);
        assertEq(usdc.balanceOf(ex), 0);
        assertEq(usdt.balanceOf(ex), 0);
    }

    function test_swapRulesEnforcedByGuard() public {
        address ex = address(sys.swapExecutor);
        assertTrue(_assisted(userPk, ext.usdc, abi.encodeCall(IERC20.approve, (ex, 1000e6))));
        uint256 dl = block.timestamp + 600;
        _deny(recoveryPk, ex, _swapData(ext.usdc, 100e6, 100e6, dl), SecurityGuard.RoleNotAllowed.selector);
        _deny(
            userPk,
            ex,
            _swapData(0x4200000000000000000000000000000000000006, 100e6, 100e6, dl),
            SecurityGuard.UnsupportedToken.selector
        );
        _deny(userPk, ex, _swapData(ext.usdc, 0, 0, dl), SecurityGuard.ZeroAmount.selector);
        _deny(userPk, ex, _swapData(ext.usdc, 100e6, 99_499_999, dl), SecurityGuard.MinOutBelowFloor.selector);
        _deny(
            userPk, ex, _swapData(ext.usdc, 100e6, 100e6, block.timestamp - 1), SecurityGuard.DeadlineExpired.selector
        );
        // tokenOut revocado por un guardián (revocación inmediata).
        vm.prank(guardian1);
        sys.policyRegistry.revokeSupportedToken(ext.usdt);
        _deny(userPk, ex, _swapData(ext.usdc, 100e6, 100e6, dl), SecurityGuard.UnsupportedToken.selector);
    }

    /// Un executor no registrado no es un swap: en RESTRICTED se deniega como operación desconocida y su approve
    /// es una autoridad económica.
    function test_unregisteredExecutorRejected() public {
        SwapExecutorV3 rogue = new SwapExecutorV3(ext.usdc, ext.usdt, ext.uniswapV3Pool, ext.uniswapV3Factory);
        _deny(
            userPk,
            ext.usdc,
            abi.encodeCall(IERC20.approve, (address(rogue), 1e6)),
            SecurityGuard.EconomicAuthorityDenied.selector
        );
        _deny(
            userPk,
            address(rogue),
            _swapData(ext.usdc, 1e6, 1e6, block.timestamp + 1),
            SecurityGuard.OperationNotPermitted.selector
        );
    }

    /// A16: las post-condiciones del Guard detienen a un executor registrado que se porta mal.
    function test_guardPostConditionsCatchMisbehavingExecutors() public {
        _deploySystem(PolicyRegistry.Mode.Bootstrap, true);
        safe = _createWallet(userKey, recoveryKey, executor, 50);
        _fund(ext.usdc, address(safe), 1000e6);
        for (uint8 mode; mode < 3; ++mode) {
            AdversarialExecutor bad = new AdversarialExecutor(ext.usdc, ext.usdt, mode);
            deal(ext.usdt, address(bad), 1000e6);
            vm.prank(admin);
            sys.policyRegistry.setSwapExecutor(address(bad), true);
            assertTrue(
                _assisted(userPk, ext.usdc, abi.encodeCall(IERC20.approve, (address(bad), mode == 0 ? 200e6 : 100e6)))
            );
            _deny(
                userPk,
                address(bad),
                _swapData(ext.usdc, 100e6, 100e6, block.timestamp + 1),
                SecurityGuard.SwapPostConditionFailed.selector
            );
            assertTrue(_assisted(userPk, ext.usdc, abi.encodeCall(IERC20.approve, (address(bad), 0))));
        }
        assertEq(usdc.balanceOf(address(safe)), 1000e6, "ninguna ejecucion maliciosa se concreto");
    }

    function test_decimalsMismatchRejected() public {
        _deploySystem(PolicyRegistry.Mode.Bootstrap, true);
        safe = _createWallet(userKey, recoveryKey, executor, 51);
        vm.prank(admin);
        sys.policyRegistry.setSupportedToken(ext.usdt, 18, true);
        _deny(
            userPk,
            address(sys.swapExecutor),
            _swapData(ext.usdc, 1e6, 1e6, block.timestamp + 1),
            SecurityGuard.DecimalsMismatch.selector
        );
    }
}
