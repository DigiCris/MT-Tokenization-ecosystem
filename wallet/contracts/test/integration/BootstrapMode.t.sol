// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SystemFixture} from "../utils/SystemFixture.sol";
import {PolicyRegistry} from "../../src/PolicyRegistry.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";
import {ISafe} from "../../src/interfaces/ISafe.sol";

/// @notice Perfil BOOTSTRAP (desarrollo de contratos, P07.T09): operaciones desconocidas permitidas, pero las
///         autoridades económicas, las llamadas administrativas y las reglas tipificadas siguen vigentes.
contract BootstrapModeTest is SystemFixture {
    function setUp() public {
        _setUpSystem(PolicyRegistry.Mode.Bootstrap);
    }

    function test_unknownOperationAllowedInBootstrap() public {
        assertFalse(sys.policyRegistry.isRestricted());
        assertTrue(_exec(safe, executor, _call(makeAddr("eoa"), ""), _pair(userPk, executorPk)));
    }

    function test_hardRulesStillApplyInBootstrap() public {
        _execExpectRevert(
            safe,
            executor,
            _call(ext.permit2, ""),
            _pair(userPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.EconomicAuthorityDenied.selector)
        );
        _execExpectRevert(
            safe,
            executor,
            _call(ext.usdc, abi.encodeCall(IERC20.transferFrom, (address(safe), userKey, 1))),
            _pair(userPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.EconomicAuthorityDenied.selector)
        );
        _execExpectRevert(
            safe,
            executor,
            _call(address(safe), abi.encodeCall(ISafe.approveHash, (bytes32(0)))),
            _pair(userPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.AdminCallForbidden.selector)
        );
        _execExpectRevert(
            safe,
            executor,
            _call(ext.usdc, abi.encodeCall(IERC20.transfer, (makeAddr("x"), 1))),
            _pair(recoveryPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.RecoveryCannotTransfer.selector)
        );
    }

    /// En BOOTSTRAP una transferencia de un token no soportado no exige registro (sí whitelist).
    function test_unsupportedTokenTransferNeedsOnlyWhitelistInBootstrap() public {
        address weth = 0x4200000000000000000000000000000000000006;
        _execExpectRevert(
            safe,
            executor,
            _call(weth, abi.encodeCall(IERC20.transfer, (makeAddr("x"), 1))),
            _pair(userPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.DestinationNotWhitelisted.selector)
        );
    }
}
