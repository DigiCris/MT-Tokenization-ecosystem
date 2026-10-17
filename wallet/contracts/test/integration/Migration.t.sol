// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SystemFixture} from "../utils/SystemFixture.sol";
import {ISafe} from "../../src/interfaces/ISafe.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";

/// @notice [C-GRD-06] rama de migración excepcional (ADR-026): sólo hacia una Safe del sistema autorizada on-chain
///         (24 h en RESTRICTED) y con el mismo rol firmante en el destino; no exige whitelist.
contract MigrationTest is SystemFixture {
    ISafe internal target;
    uint256 internal t0;

    function setUp() public {
        _setUpSystem();
        t0 = block.timestamp;
        (address s2,) = makeAddrAndKey("migration-target-s");
        target = _createWallet(userKey, recoveryKey, s2, 11);
        _fund(ext.usdc, address(safe), 300e6);
    }

    function _authorize(address from, address to) internal {
        vm.prank(admin);
        bytes32 id = sys.policyRegistry.proposeMigrationAuthorization(from, to);
        vm.warp(t0 + 24 hours);
        sys.policyRegistry.activateChange(id);
    }

    function _transfer(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.transfer, (to, amount));
    }

    function test_migrationToAuthorizedSystemSafe() public {
        _authorize(address(safe), address(target));
        assertTrue(_exec(safe, executor, _call(ext.usdc, _transfer(address(target), 100e6)), _pair(userPk, executorPk)));
        assertTrue(
            _exec(safe, executor, _call(ext.usdc, _transfer(address(target), 50e6)), _pair(recoveryPk, executorPk))
        );
        assertEq(IERC20(ext.usdc).balanceOf(address(target)), 150e6);
    }

    function test_migrationRequiresAuthorizationAndMatchingRole() public {
        // Sin autorización: camino normal (U sin whitelist, R nunca).
        _execExpectRevert(
            safe,
            executor,
            _call(ext.usdc, _transfer(address(target), 1e6)),
            _pair(userPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.DestinationNotWhitelisted.selector)
        );
        _execExpectRevert(
            safe,
            executor,
            _call(ext.usdc, _transfer(address(target), 1e6)),
            _pair(recoveryPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.RecoveryCannotTransfer.selector)
        );
        // Autorizada pero con otra U en el destino.
        (address u3,) = makeAddrAndKey("other-user");
        (address s3,) = makeAddrAndKey("other-s");
        ISafe other = _createWallet(u3, recoveryKey, s3, 12);
        address eoa = makeAddr("authorized-eoa");
        vm.startPrank(admin);
        bytes32 a = sys.policyRegistry.proposeMigrationAuthorization(address(safe), address(other));
        bytes32 b = sys.policyRegistry.proposeMigrationAuthorization(address(safe), eoa);
        vm.stopPrank();
        vm.warp(t0 + 24 hours);
        sys.policyRegistry.activateChange(a);
        sys.policyRegistry.activateChange(b);
        _execExpectRevert(
            safe,
            executor,
            _call(ext.usdc, _transfer(address(other), 1e6)),
            _pair(userPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.MigrationRoleMismatch.selector)
        );
        // Con R la recoveryKey sí coincide.
        assertTrue(
            _exec(safe, executor, _call(ext.usdc, _transfer(address(other), 1e6)), _pair(recoveryPk, executorPk))
        );
        // Un destino autorizado que no es una Safe del sistema.
        _execExpectRevert(
            safe,
            executor,
            _call(ext.usdc, _transfer(eoa, 1e6)),
            _pair(userPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.MigrationRoleMismatch.selector)
        );
    }
}
