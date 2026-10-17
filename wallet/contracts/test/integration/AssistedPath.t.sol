// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SystemFixture} from "../utils/SystemFixture.sol";
import {ISafe, Operation} from "../../src/interfaces/ISafe.sol";
import {IDestinationWhitelist} from "../../src/interfaces/IDestinationWhitelist.sol";
import {IRotationTimelock} from "../../src/interfaces/IRotationTimelock.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";
import {PolicyRegistry} from "../../src/PolicyRegistry.sol";
import {WalletFactory} from "../../src/WalletFactory.sol";
import {SafeBootstrap} from "../../src/SafeBootstrap.sol";
import {Role} from "../../src/libraries/Roles.sol";

interface ISafeAdmin {
    function addOwnerWithThreshold(address owner, uint256 threshold) external;
    function changeThreshold(uint256 threshold) external;
    function enableModule(address module) external;
    function setFallbackHandler(address handler) external;
}

/// @notice P05.T06 (camino asistido) con la Safe v1.5.0 real del fork, sistema RESTRICTED con el set V1:
///         A1–A4, A8, A9, A10, A12, A13 y las reglas de [C-GRD-03..13].
contract AssistedPathTest is SystemFixture {
    IERC20 internal usdc;
    address internal dest;
    uint256 internal t0;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;

    function setUp() public {
        _setUpSystem();
        usdc = IERC20(ext.usdc);
        dest = makeAddr("dest");
        t0 = block.timestamp;
        _fund(ext.usdc, address(safe), 1000e6);
        assertTrue(
            _assisted(
                userPk, address(sys.destinationWhitelist), abi.encodeCall(IDestinationWhitelist.addDestination, (dest))
            )
        );
        vm.warp(t0 + 24 hours);
    }

    function _assisted(uint256 cosignerPk, address to, bytes memory data) internal returns (bool) {
        return _exec(safe, executor, _call(to, data), _pair(cosignerPk, executorPk));
    }

    function _deny(uint256 cosignerPk, address to, bytes memory data, bytes4 err) internal {
        _execExpectRevert(safe, executor, _call(to, data), _pair(cosignerPk, executorPk), abi.encodeWithSelector(err));
    }

    function _transfer(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.transfer, (to, amount));
    }

    // ------------------------------------------------------------------------------------------
    // [C-GRD-05] NOOP y A13

    function test_noOpByUserAndRecovery() public {
        uint256 n = safe.nonce();
        assertTrue(_assisted(userPk, address(safe), ""));
        assertTrue(_assisted(recoveryPk, address(safe), ""));
        assertEq(safe.nonce(), n + 2);
    }

    /// A13: un NoOp con el nonce N invalida cualquier SafeTx pendiente con ese nonce.
    function test_noOpCancelsPendingNonce() public {
        SafeTx memory pending = _call(ext.usdc, _transfer(dest, 10e6));
        bytes memory pendingSigs = _sigs(_txHash(safe, pending, safe.nonce()), _pair(userPk, executorPk));
        assertTrue(_assisted(userPk, address(safe), ""));
        vm.expectRevert(bytes("GS026"));
        _execRaw(safe, executor, pending, pendingSigs);
        assertEq(usdc.balanceOf(dest), 0);
    }

    // ------------------------------------------------------------------------------------------
    // [C-GRD-06] TRANSFER (A9)

    function test_transferToActiveWhitelistedDestination() public {
        assertTrue(_assisted(userPk, ext.usdc, _transfer(dest, 25e6)));
        assertEq(usdc.balanceOf(dest), 25e6);
        assertEq(usdc.balanceOf(address(safe)), 975e6);
    }

    function test_transferRejectsNonWhitelistedAndPendingDestinations() public {
        _deny(
            userPk,
            ext.usdc,
            _transfer(makeAddr("not-whitelisted"), 1e6),
            SecurityGuard.DestinationNotWhitelisted.selector
        );
        address fresh = makeAddr("fresh");
        assertTrue(
            _assisted(
                userPk, address(sys.destinationWhitelist), abi.encodeCall(IDestinationWhitelist.addDestination, (fresh))
            )
        );
        _deny(userPk, ext.usdc, _transfer(fresh, 1e6), SecurityGuard.DestinationNotWhitelisted.selector);
        vm.warp(t0 + 48 hours);
        assertTrue(_assisted(userPk, ext.usdc, _transfer(fresh, 1e6)));
    }

    function test_transferRules() public {
        _deny(recoveryPk, ext.usdc, _transfer(dest, 1e6), SecurityGuard.RecoveryCannotTransfer.selector);
        _deny(userPk, ext.usdc, _transfer(dest, 0), SecurityGuard.ZeroAmount.selector);
        _deny(userPk, WETH, _transfer(dest, 1), SecurityGuard.UnsupportedToken.selector);
        address[10] memory forbidden = [
            address(safe),
            address(0),
            ext.usdt,
            ext.permit2,
            address(sys.securityGuard),
            address(sys.policyRegistry),
            address(sys.destinationWhitelist),
            address(sys.rotationTimelock),
            address(sys.walletFactory),
            address(sys.safeBootstrap)
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            _deny(userPk, ext.usdc, _transfer(forbidden[i], 1e6), SecurityGuard.InvalidDestination.selector);
        }
        _deny(
            userPk, ext.usdc, _transfer(address(sys.denyAllModuleGuard), 1e6), SecurityGuard.InvalidDestination.selector
        );
    }

    // ------------------------------------------------------------------------------------------
    // [C-GRD-07] APPROVE y [C-GRD-08] autoridades económicas (A10)

    function test_approveOnlyToRegisteredExecutor() public {
        address exec = address(sys.swapExecutor);
        assertTrue(_assisted(userPk, ext.usdc, abi.encodeCall(IERC20.approve, (exec, 100e6))));
        assertEq(usdc.allowance(address(safe), exec), 100e6);
        _deny(
            userPk,
            ext.usdc,
            abi.encodeCall(IERC20.approve, (exec, 1001e6)),
            SecurityGuard.ApproveExceedsBalance.selector
        );
        _deny(
            userPk,
            ext.usdc,
            abi.encodeCall(IERC20.approve, (ext.permit2, 1)),
            SecurityGuard.EconomicAuthorityDenied.selector
        );
        _deny(
            userPk, ext.usdc, abi.encodeCall(IERC20.approve, (dest, 1)), SecurityGuard.EconomicAuthorityDenied.selector
        );
        _deny(
            recoveryPk,
            ext.usdc,
            abi.encodeCall(IERC20.approve, (exec, 1)),
            SecurityGuard.RecoveryCanOnlyRevoke.selector
        );
        _deny(userPk, WETH, abi.encodeCall(IERC20.approve, (exec, 1)), SecurityGuard.UnsupportedToken.selector);
        // R sólo revoca (APPROVE_REVOKE).
        assertTrue(_assisted(recoveryPk, ext.usdc, abi.encodeCall(IERC20.approve, (exec, 0))));
        assertEq(usdc.allowance(address(safe), exec), 0);
    }

    function test_economicAuthorityAlwaysDenied() public {
        _deny(
            userPk,
            ext.usdc,
            abi.encodeWithSignature("increaseAllowance(address,uint256)", dest, 1),
            SecurityGuard.EconomicAuthorityDenied.selector
        );
        _deny(
            userPk,
            ext.usdc,
            abi.encodeCall(IERC20.transferFrom, (address(safe), dest, 1)),
            SecurityGuard.EconomicAuthorityDenied.selector
        );
        _deny(
            userPk,
            ext.usdc,
            abi.encodeCall(
                IERC20Permit.permit, (address(safe), dest, 1, type(uint256).max, 27, bytes32(0), bytes32(0))
            ),
            SecurityGuard.EconomicAuthorityDenied.selector
        );
        // Cualquier llamada a Permit2, con cualquier selector.
        _deny(
            userPk,
            ext.permit2,
            abi.encodeWithSignature("approve(address,address,uint160,uint48)", ext.usdc, dest, 1, 1),
            SecurityGuard.EconomicAuthorityDenied.selector
        );
        _deny(userPk, ext.permit2, "", SecurityGuard.EconomicAuthorityDenied.selector);
    }

    // ------------------------------------------------------------------------------------------
    // [C-GRD-03] pasos 4–5: combinación de signers, tipo de firma, executor e invariantes estructurales

    /// A1, A2, A3: ninguna clave sola alcanza el threshold.
    /// A1, A2, A3: ninguna clave sola alcanza el threshold 2 (la Safe revierte antes de llamar al Guard), ni la misma
    /// clave repetida (la Safe exige owners distintos en orden ascendente).
    function test_singleKeyCannotExecute() public {
        SafeTx memory t = _call(address(safe), "");
        uint256[3] memory keys = [userPk, recoveryPk, executorPk];
        for (uint256 i; i < 3; ++i) {
            uint256[] memory one = new uint256[](1);
            one[0] = keys[i];
            bytes memory sig = _sigs(_txHash(safe, t, safe.nonce()), one);
            vm.expectRevert(bytes("GS020"));
            _execRaw(safe, executor, t, sig);
        }
        for (uint256 i; i < 3; ++i) {
            uint256[] memory twice = new uint256[](2);
            twice[0] = keys[i];
            twice[1] = keys[i];
            bytes memory sig = _sigs(_txHash(safe, t, safe.nonce()), twice);
            vm.expectRevert(bytes("GS026"));
            _execRaw(safe, executor, t, sig);
        }
    }

    function test_msgSenderMustBeExecutor() public {
        _execExpectRevert(
            safe,
            makeAddr("relayer"),
            _call(address(safe), ""),
            _pair(userPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.WrongExecutor.selector)
        );
    }

    /// Firma de S tipo `v = 1` (válida para la Safe porque S es el ejecutor): el Guard exige ECDSA.
    function test_executorApprovedHashSignatureRejected() public {
        SafeTx memory t = _call(address(safe), "");
        bytes32 h = _txHash(safe, t, safe.nonce());
        bytes memory u = _ecdsa(userPk, h);
        bytes memory s = _approvedHashSig(executor);
        bytes memory sigs = userKey < executor ? bytes.concat(u, s) : bytes.concat(s, u);
        vm.expectRevert(SecurityGuard.UnsupportedSignatureType.selector);
        _execRaw(safe, executor, t, sigs);
    }

    function test_ethSignCosignerRejected() public {
        SafeTx memory t = _call(address(safe), "");
        bytes32 h = _txHash(safe, t, safe.nonce());
        bytes memory u = _ethSign(userPk, h);
        bytes memory s = _ecdsa(executorPk, h);
        bytes memory sigs = userKey < executor ? bytes.concat(u, s) : bytes.concat(s, u);
        vm.expectRevert(SecurityGuard.UnsupportedSignatureType.selector);
        _execRaw(safe, executor, t, sigs);
    }

    function test_structuralInvariants() public {
        SafeTx memory t = _call(address(safe), "");
        t.operation = Operation.DelegateCall;
        _execExpectRevert(
            safe,
            executor,
            t,
            _pair(userPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.DelegateCallForbidden.selector)
        );
        t = _call(address(safe), "");
        t.safeTxGas = 1;
        _execExpectRevert(
            safe,
            executor,
            t,
            _pair(userPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.GasParametersForbidden.selector)
        );
        t = _call(address(safe), "");
        t.gasToken = ext.usdc;
        _execExpectRevert(
            safe,
            executor,
            t,
            _pair(userPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.GasParametersForbidden.selector)
        );
        t = _call(address(safe), "");
        t.refundReceiver = dest;
        _execExpectRevert(
            safe,
            executor,
            t,
            _pair(userPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.GasParametersForbidden.selector)
        );
        t = _call(address(safe), "");
        t.baseGas = 1;
        _execExpectRevert(
            safe,
            executor,
            t,
            _pair(userPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.GasParametersForbidden.selector)
        );
        vm.deal(address(safe), 1 ether);
        t = _call(dest, "");
        t.value = 1 wei;
        _execExpectRevert(
            safe,
            executor,
            t,
            _pair(userPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.ValueTransferForbidden.selector)
        );
    }

    // ------------------------------------------------------------------------------------------
    // [C-GRD-13] llamadas administrativas y a contratos del sistema

    function test_adminCallsToSafeForbidden() public {
        bytes[6] memory calls = [
            abi.encodeCall(ISafeAdmin.addOwnerWithThreshold, (dest, 2)),
            abi.encodeCall(ISafeAdmin.changeThreshold, (1)),
            abi.encodeCall(ISafeAdmin.enableModule, (dest)),
            abi.encodeCall(ISafeAdmin.setFallbackHandler, (ext.compatibilityFallbackHandler)),
            abi.encodeCall(ISafe.approveHash, (bytes32(uint256(1)))),
            abi.encodeWithSignature("simulateAndRevert(address,bytes)", dest, "")
        ];
        for (uint256 i; i < calls.length; ++i) {
            _deny(userPk, address(safe), calls[i], SecurityGuard.AdminCallForbidden.selector);
        }
        // setGuard: sólo vía GUARD_UPGRADE (U, sucesor registrado y propuesta madura).
        _deny(
            userPk,
            address(safe),
            abi.encodeCall(ISafe.setGuard, (address(0))),
            SecurityGuard.GuardUpgradeNotAuthorized.selector
        );
        _deny(
            recoveryPk,
            address(safe),
            abi.encodeCall(ISafe.setGuard, (address(0))),
            SecurityGuard.RoleNotAllowed.selector
        );
    }

    function test_systemContractsForbidden() public {
        _deny(
            userPk,
            address(sys.securityGuard),
            abi.encodeCall(SecurityGuard.updateRoles, (userKey, recoveryKey, executor)),
            SecurityGuard.AdminCallForbidden.selector
        );
        _deny(
            userPk,
            address(sys.policyRegistry),
            abi.encodeCall(PolicyRegistry.revokeSwapExecutor, (address(sys.swapExecutor))),
            SecurityGuard.AdminCallForbidden.selector
        );
        _deny(userPk, address(sys.denyAllModuleGuard), "", SecurityGuard.AdminCallForbidden.selector);
        _deny(
            userPk,
            address(sys.walletFactory),
            abi.encodeCall(WalletFactory.createWallet, (userKey, recoveryKey, executor, 5)),
            SecurityGuard.AdminCallForbidden.selector
        );
        _deny(
            userPk,
            address(sys.safeBootstrap),
            abi.encodeCall(SafeBootstrap.bootstrap, (userKey, recoveryKey, executor)),
            SecurityGuard.AdminCallForbidden.selector
        );
        _deny(
            userPk,
            address(sys.rotationTimelock),
            abi.encodeCall(IRotationTimelock.markExecuted, (bytes32(0))),
            SecurityGuard.AdminCallForbidden.selector
        );
        _deny(
            userPk,
            address(sys.destinationWhitelist),
            abi.encodeCall(IDestinationWhitelist.destinationsOf, (address(safe))),
            SecurityGuard.AdminCallForbidden.selector
        );
        _deny(
            userPk,
            address(sys.swapExecutor),
            abi.encodeWithSignature("tokenOutFor(address)", ext.usdc),
            SecurityGuard.AdminCallForbidden.selector
        );
    }

    /// RESTRICTED: toda operación no tipificada se deniega (default DENY).
    function test_unknownOperationDeniedInRestricted() public {
        _deny(userPk, dest, "", SecurityGuard.OperationNotPermitted.selector);
        _deny(
            userPk,
            makeAddr("contrato"),
            abi.encodeWithSignature("doSomething()"),
            SecurityGuard.OperationNotPermitted.selector
        );
    }

    // ------------------------------------------------------------------------------------------
    // [C-GRD-10] WHITELIST

    function test_whitelistRules() public {
        address d2 = makeAddr("d2");
        _deny(
            recoveryPk,
            address(sys.destinationWhitelist),
            abi.encodeCall(IDestinationWhitelist.addDestination, (d2)),
            SecurityGuard.RoleNotAllowed.selector
        );
        address[6] memory forbidden =
            [address(safe), address(0), ext.usdc, address(sys.swapExecutor), address(sys.securityGuard), ext.permit2];
        for (uint256 i; i < forbidden.length; ++i) {
            _deny(
                userPk,
                address(sys.destinationWhitelist),
                abi.encodeCall(IDestinationWhitelist.addDestination, (forbidden[i])),
                SecurityGuard.InvalidDestination.selector
            );
        }
        assertTrue(
            _assisted(
                recoveryPk,
                address(sys.destinationWhitelist),
                abi.encodeCall(IDestinationWhitelist.removeDestination, (dest))
            )
        );
        assertFalse(sys.destinationWhitelist.isWhitelisted(address(safe), dest));
    }

    // ------------------------------------------------------------------------------------------
    // A12: una firma no se reusa con otro nonce ni en otra Safe

    /// A12: una firma no se reusa con otro nonce, otra Safe ni otra cadena (dominio EIP-712 de la Safe con chainId
    /// y `verifyingContract`, y el nonce dentro del hash).
    function test_signaturesCannotBeReplayed() public {
        SafeTx memory t = _call(ext.usdc, _transfer(dest, 1e6));
        bytes memory sigs = _sigs(_txHash(safe, t, safe.nonce()), _pair(userPk, executorPk));
        assertTrue(_execRaw(safe, executor, t, sigs));
        // Mismo par de firmas con el nonce siguiente.
        vm.expectRevert(bytes("GS026"));
        _execRaw(safe, executor, t, sigs);
        // Otra Safe con las mismas claves.
        ISafe other = _createWallet(userKey, recoveryKey, executor, 1);
        _fund(ext.usdc, address(other), 10e6);
        bytes memory forOther = _sigs(_txHash(safe, t, other.nonce()), _pair(userPk, executorPk));
        vm.expectRevert(bytes("GS026"));
        _execRaw(other, executor, t, forOther);
        // Otra cadena: la misma SafeTx firmada para chainId 1.
        uint256 n = safe.nonce();
        vm.chainId(1);
        bytes32 foreign = _txHash(safe, t, n);
        vm.chainId(ext.chainId);
        assertTrue(foreign != _txHash(safe, t, n), "el dominio incluye el chainId");
        bytes memory forOtherChain = _sigs(foreign, _pair(userPk, executorPk));
        vm.expectRevert(bytes("GS026"));
        _execRaw(safe, executor, t, forOtherChain);
    }

    // ------------------------------------------------------------------------------------------
    // [C-GRD-02] evaluateAssisted (pre-check de backend y signer)

    function test_evaluateAssistedMatchesGuard() public {
        (bool ok, bytes32 reason) =
            sys.securityGuard.evaluateAssisted(address(safe), Role.User, ext.usdc, 0, _transfer(dest, 1e6));
        assertTrue(ok);
        assertEq(reason, bytes32(0));
        (ok, reason) =
            sys.securityGuard.evaluateAssisted(address(safe), Role.Recovery, ext.usdc, 0, _transfer(dest, 1e6));
        assertFalse(ok);
        assertEq(reason, bytes32(SecurityGuard.RecoveryCannotTransfer.selector));
        (ok, reason) = sys.securityGuard.evaluateAssisted(address(safe), Role.User, ext.permit2, 0, "");
        assertEq(reason, bytes32(SecurityGuard.EconomicAuthorityDenied.selector));
        (ok, reason) = sys.securityGuard.evaluateAssisted(address(safe), Role.User, dest, 1, "");
        assertEq(reason, bytes32(SecurityGuard.ValueTransferForbidden.selector));
        (ok, reason) = sys.securityGuard.evaluateAssisted(address(safe), Role.Executor, address(safe), 0, "");
        assertEq(reason, bytes32(SecurityGuard.UnknownCosigner.selector));
        (ok, reason) = sys.securityGuard.evaluateAssisted(makeAddr("x"), Role.User, address(safe), 0, "");
        assertEq(reason, bytes32(SecurityGuard.UnregisteredSafe.selector));
    }

    function test_unregisteredCallerRejected() public {
        vm.expectRevert(SecurityGuard.UnregisteredSafe.selector);
        sys.securityGuard
            .checkTransaction(dest, 0, "", Operation.Call, 0, 0, 0, address(0), payable(address(0)), "", executor);
    }

    /// checkAfterExecution sin contexto (llamado por cualquiera) nunca revierte.
    function test_checkAfterExecutionWithoutContextIsNoop() public {
        sys.securityGuard.checkAfterExecution(bytes32(0), false);
        vm.prank(address(safe));
        sys.securityGuard.checkAfterExecution(bytes32(0), true);
    }

    function test_supportsInterface() public view {
        assertTrue(sys.securityGuard.supportsInterface(0xe6d7a83a));
        assertTrue(sys.securityGuard.supportsInterface(0x01ffc9a7));
        assertFalse(sys.securityGuard.supportsInterface(0x58401ed8));
    }
}
