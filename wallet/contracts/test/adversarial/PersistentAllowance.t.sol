// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AdversarialBase} from "./AdversarialBase.sol";
import {ChainConfig} from "../../script/lib/ChainConfig.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";
import {SwapExecutorV3} from "../../src/SwapExecutorV3.sol";

/// @notice P07.T01.k — allowance persistente (A10, A15): ningún approve hacia Permit2, routers u otro spender, ningún
///         selector de autoridad de [C-DEC-03], y la única allowance permitida (al executor registrado) no la puede
///         usar un tercero y queda en 0 después del swap.
contract PersistentAllowanceAttackTest is AdversarialBase {
    function _approve(address spender, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.approve, (spender, amount));
    }

    function test_approveToAnySpenderButExecutorFails() public {
        (address router02,) = ChainConfig.contractAt("uniswapSwapRouter02");
        (address universal,) = ChainConfig.contractAt("uniswapUniversalRouter");
        address[6] memory spenders = [ext.permit2, router02, universal, attacker, dest, address(sys.securityGuard)];
        address[2] memory tokens = [ext.usdc, ext.usdt];
        for (uint256 t; t < 2; ++t) {
            for (uint256 i; i < spenders.length; ++i) {
                _deny(userPk, tokens[t], _approve(spenders[i], 1e6), SecurityGuard.EconomicAuthorityDenied.selector);
                assertEq(IERC20(tokens[t]).allowance(address(safe), spenders[i]), 0);
            }
        }
    }

    /// Cada selector de autoridad económica, contra USDC, USDT y un token cualquiera, y cualquier llamada a Permit2.
    function test_everyAuthoritySelectorDenied() public {
        address a = attacker;
        address s = address(safe);
        uint256[] memory ids = new uint256[](1);
        bytes[25] memory calls = [
            abi.encodeWithSignature("increaseAllowance(address,uint256)", a, 1),
            abi.encodeWithSignature("decreaseAllowance(address,uint256)", a, 1),
            abi.encodeWithSignature(
                "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
                s,
                a,
                1,
                1,
                uint8(27),
                bytes32(0),
                bytes32(0)
            ),
            abi.encodeWithSignature("permit(address,address,uint256,uint256,bytes)", s, a, 1, 1, ""),
            abi.encodeWithSignature(
                "permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)",
                s,
                a,
                0,
                1,
                true,
                uint8(27),
                bytes32(0),
                bytes32(0)
            ),
            abi.encodeWithSignature("setApprovalForAll(address,bool)", a, true),
            abi.encodeWithSignature("transferFrom(address,address,uint256)", s, a, 1),
            abi.encodeWithSignature("authorizeOperator(address)", a),
            abi.encodeWithSignature("send(address,uint256,bytes)", a, 1, ""),
            abi.encodeWithSignature("operatorSend(address,address,uint256,bytes,bytes)", s, a, 1, "", ""),
            abi.encodeWithSignature(
                "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
                s,
                a,
                1,
                0,
                1,
                bytes32(0),
                uint8(27),
                bytes32(0),
                bytes32(0)
            ),
            abi.encodeWithSignature(
                "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
                s,
                a,
                1,
                0,
                1,
                bytes32(0),
                ""
            ),
            abi.encodeWithSignature(
                "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
                s,
                a,
                1,
                0,
                1,
                bytes32(0),
                uint8(27),
                bytes32(0),
                bytes32(0)
            ),
            abi.encodeWithSignature(
                "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
                s,
                a,
                1,
                0,
                1,
                bytes32(0),
                ""
            ),
            abi.encodeWithSignature("transferAndCall(address,uint256)", a, 1),
            abi.encodeWithSignature("transferAndCall(address,uint256,bytes)", a, 1, ""),
            abi.encodeWithSignature("transferFromAndCall(address,address,uint256)", s, a, 1),
            abi.encodeWithSignature("transferFromAndCall(address,address,uint256,bytes)", s, a, 1, ""),
            abi.encodeWithSignature("approveAndCall(address,uint256)", a, 1),
            abi.encodeWithSignature("approveAndCall(address,uint256,bytes)", a, 1, ""),
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", s, a, 1),
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256,bytes)", s, a, 1, ""),
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256,uint256,bytes)", s, a, 1, 1, ""),
            abi.encodeWithSignature(
                "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)", s, a, ids, ids, ""
            ),
            abi.encodeWithSignature("approve(address,address,uint160,uint48)", ext.usdc, a, uint160(1), uint48(1))
        ];
        address[3] memory targets = [ext.usdc, ext.usdt, makeAddr("any-token")];
        for (uint256 t; t < targets.length; ++t) {
            for (uint256 i; i < calls.length - 1; ++i) {
                _deny(userPk, targets[t], calls[i], SecurityGuard.EconomicAuthorityDenied.selector);
            }
        }
        // Permit2: cualquier llamada (approve de Permit2, vacía o desconocida).
        _deny(userPk, ext.permit2, calls[calls.length - 1], SecurityGuard.EconomicAuthorityDenied.selector);
        _deny(userPk, ext.permit2, "", SecurityGuard.EconomicAuthorityDenied.selector);
        _deny(recoveryPk, ext.permit2, hex"deadbeef", SecurityGuard.EconomicAuthorityDenied.selector);
        _assertSafeUntouched();
    }

    /// Approve N firmado y swap N+1 que nunca llega: la allowance residual al executor no la usa un tercero, el pool no
    /// cobra sin swap en curso y R la puede revocar.
    function test_residualAllowanceUnusableByThirdParties() public {
        address ex = address(sys.swapExecutor);
        assertTrue(_assisted(userPk, ext.usdc, _approve(ex, 100e6)));
        assertEq(usdc.allowance(address(safe), ex), 100e6);
        vm.prank(attacker);
        vm.expectRevert(bytes("ERC20: transfer amount exceeds allowance"));
        sys.swapExecutor.swap(ext.usdc, 100e6, 99.5e6, block.timestamp);
        vm.prank(ext.uniswapV3Pool);
        vm.expectRevert(SwapExecutorV3.UnauthorizedCallback.selector);
        sys.swapExecutor.uniswapV3SwapCallback(100e6, 0, "");
        _assertSafeUntouched();
        assertTrue(_assisted(recoveryPk, ext.usdc, _approve(ex, 0)));
        assertEq(usdc.allowance(address(safe), ex), 0);
    }

    function test_allowanceIsZeroAfterAssistedSwap() public {
        address ex = address(sys.swapExecutor);
        assertTrue(_assisted(userPk, ext.usdc, _approve(ex, 100e6)));
        assertTrue(
            _assisted(userPk, ex, abi.encodeCall(SwapExecutorV3.swap, (ext.usdc, 100e6, 99.5e6, block.timestamp)))
        );
        assertEq(usdc.allowance(address(safe), ex), 0);
        assertEq(usdc.balanceOf(ex), 0);
        assertEq(usdt.balanceOf(ex), 0);
    }

    function test_oversizedAndRecoveryApprovalsFail() public {
        address ex = address(sys.swapExecutor);
        _deny(userPk, ext.usdc, _approve(ex, SAFE_FUNDS + 1), SecurityGuard.ApproveExceedsBalance.selector);
        _deny(userPk, ext.usdc, _approve(ex, type(uint256).max), SecurityGuard.ApproveExceedsBalance.selector);
        _deny(recoveryPk, ext.usdc, _approve(ex, 1), SecurityGuard.RecoveryCanOnlyRevoke.selector);
        assertEq(usdc.allowance(address(safe), ex), 0);
    }
}
