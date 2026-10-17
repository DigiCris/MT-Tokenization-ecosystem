// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SystemFixture} from "../utils/SystemFixture.sol";
import {WalletHandler} from "./handlers/WalletHandler.sol";
import {ChainConfig} from "../../script/lib/ChainConfig.sol";

/// @notice P07.T02 — invariantes A1–A17 sobre la Safe real del fork, en el modo de `POLICY_MODE` (P07.T09): el handler
///         ejecuta secuencias aleatorias de operaciones asistidas (legítimas y abusivas), soberanas y avances de tiempo;
///         cada invariante exige que ningún ataque haya tenido éxito y que el estado coincida con el modelo.
/// @dev Cada llamada del handler son varias SafeTx reales sobre el fork (~0,1 s de CPU), así que este suite fija sus
///      runs: profundidad 50 en `ci` (como el perfil) con 32 runs por modo (1.600 secuencias de llamadas), y 16×32 en
///      `default` para el desarrollo local.
/// forge-config: default.invariant.runs = 16
/// forge-config: default.invariant.depth = 32
/// forge-config: ci.invariant.runs = 32
/// forge-config: ci.invariant.depth = 50
contract WalletInvariantsTest is SystemFixture {
    WalletHandler internal handler;
    IERC20 internal usdc;
    IERC20 internal usdt;
    address internal router02;

    function setUp() public {
        _fork();
        _keys();
        _deploySystem(_policyMode(), true);
        safe = _createWallet(userKey, recoveryKey, executor, 0);
        _fund(ext.usdc, address(safe), 10_000e6);
        _fund(ext.usdt, address(safe), 10_000e6);
        usdc = IERC20(ext.usdc);
        usdt = IERC20(ext.usdt);
        (router02,) = ChainConfig.contractAt("uniswapSwapRouter02");
        handler = new WalletHandler(
            safe, sys, ext.usdc, ext.usdt, ext.permit2, ext.multiSendCallOnly, userPk, recoveryPk, executorPk
        );
        bytes4[] memory selectors = new bytes4[](25);
        selectors[0] = WalletHandler.warp.selector;
        selectors[1] = WalletHandler.whitelistAdd.selector;
        selectors[2] = WalletHandler.whitelistRemove.selector;
        selectors[3] = WalletHandler.assistedTransfer.selector;
        selectors[4] = WalletHandler.assistedSwap.selector;
        selectors[5] = WalletHandler.proposeExecutorRotation.selector;
        selectors[6] = WalletHandler.executeRotation.selector;
        selectors[7] = WalletHandler.cancelRotationByRecovery.selector;
        selectors[8] = WalletHandler.sovereignTransfer.selector;
        selectors[9] = WalletHandler.sovereignRotateExecutor.selector;
        selectors[10] = WalletHandler.sovereignModuleToggle.selector;
        selectors[11] = WalletHandler.attackSingleKey.selector;
        selectors[12] = WalletHandler.attackWrongSender.selector;
        selectors[13] = WalletHandler.attackGasParams.selector;
        selectors[14] = WalletHandler.attackDelegateCall.selector;
        selectors[15] = WalletHandler.attackReplay.selector;
        selectors[16] = WalletHandler.attackAppendedSignature.selector;
        selectors[17] = WalletHandler.attackApproveThirdParty.selector;
        selectors[18] = WalletHandler.attackAuthoritySelector.selector;
        selectors[19] = WalletHandler.attackUnsupportedSwap.selector;
        selectors[20] = WalletHandler.attackModuleExecution.selector;
        selectors[21] = WalletHandler.attackResidualAllowance.selector;
        selectors[22] = WalletHandler.attackPendingAfterNoOp.selector;
        selectors[23] = WalletHandler.whitelistAdd.selector;
        selectors[24] = WalletHandler.assistedTransfer.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Las invariantes no son vacuas: una secuencia fija del handler produce operaciones exitosas de cada tipo y los
    /// ataques fallan.
    function test_handlerExercisesTheSystem() public {
        handler.whitelistAdd(0);
        handler.warp(1 days);
        handler.assistedTransfer(0, 10e6, true, false);
        assertEq(handler.assistedTransfers(), 1, "transferencia asistida a destino activo");
        handler.assistedTransfer(5, 10e6, true, false);
        assertEq(handler.assistedTransfers(), 1, "al atacante no");
        handler.assistedSwap(true, 50e6, 10, false);
        assertEq(handler.swaps(), 1, "swap asistido");
        handler.proposeExecutorRotation(0);
        handler.executeRotation();
        assertEq(handler.rotations(), 0, "rotacion antes de 48 h");
        handler.warp(2 days);
        handler.executeRotation();
        assertEq(handler.rotations(), 1, "rotacion madura");
        handler.sovereignTransfer(5, 1e6, true);
        handler.sovereignRotateExecutor(0);
        handler.sovereignModuleToggle(0);
        assertGe(handler.sovereignOps(), 4, "operaciones soberanas");
        handler.assistedSwap(false, 20e6, 0, true);
        handler.attackResidualAllowance(20e6);
        handler.attackSingleKey(0);
        handler.attackWrongSender(0);
        handler.attackGasParams(4);
        handler.attackDelegateCall();
        handler.attackReplay();
        handler.attackAppendedSignature(5e6);
        handler.attackApproveThirdParty(0);
        handler.attackAuthoritySelector(3);
        handler.attackUnsupportedSwap(1e18);
        handler.attackModuleExecution();
        handler.attackPendingAfterNoOp(true);
        invariant_A1_A2_A3_noSingleKeyOrForeignSender();
        invariant_A4_A9_assistedTransfersOnlyToActiveWhitelist();
        invariant_A6_sovereignNeverBlocked();
        invariant_A7_classificationUsesThresholdSigners();
        invariant_A8_structuralRestrictions();
        invariant_A10_A15_noThirdPartyAuthority();
        invariant_A11_configurationIntact();
        invariant_A12_A13_noReplay();
        invariant_A16_swapScope();
        invariant_A17_rotationsOnlyAfterDelay();
        invariant_fundsAccounted();
    }

    /// A1, A2, A3: ninguna clave sola ni un remitente distinto de S ejecuta una SafeTx asistida.
    function invariant_A1_A2_A3_noSingleKeyOrForeignSender() public view {
        assertEq(handler.singleKeySucceeded(), 0, "una clave sola ejecuto");
        assertEq(handler.wrongSenderSucceeded(), 0, "remitente distinto de S ejecuto");
    }

    /// A4, A9: toda transferencia asistida exitosa fue de U hacia un destino whitelisteado y activo (modelo propio de
    /// la whitelist con activación a 24 h).
    function invariant_A4_A9_assistedTransfersOnlyToActiveWhitelist() public view {
        assertEq(handler.assistedTransferToUnauthorized(), 0, "salida a destino no autorizado");
    }

    /// A5: R+S nunca transfiere.
    function invariant_A5_recoveryNeverTransfers() public view {
        assertEq(handler.recoveryTransferSucceeded(), 0, "R+S transfirio");
    }

    /// A6: toda SafeTx U+R con firmas válidas se ejecuta (el Guard nunca la revierte).
    function invariant_A6_sovereignNeverBlocked() public view {
        assertEq(handler.sovereignFailures(), 0, "camino soberano bloqueado");
    }

    /// A7: la clasificación usa sólo las firmas del threshold (una firma de R anexada no vuelve soberana a U+S).
    function invariant_A7_classificationUsesThresholdSigners() public view {
        assertEq(handler.appendedSignatureBypass(), 0, "firma anexada cambio la clasificacion");
    }

    /// A8: ninguna SafeTx asistida exitosa tuvo DELEGATECALL, parámetros de gas, gasToken, refundReceiver o value ≠ 0;
    ///     ninguna ejecución por módulo; con la configuración alterada el camino asistido no opera.
    function invariant_A8_structuralRestrictions() public view {
        assertEq(handler.delegateCallSucceeded(), 0, "DELEGATECALL asistido");
        assertEq(handler.gasParamsSucceeded(), 0, "gas params o value en asistido");
        assertEq(handler.moduleExecutionSucceeded(), 0, "ejecucion por modulo");
        assertEq(handler.assistedWhileAlteredSucceeded(), 0, "asistido con configuracion alterada");
    }

    /// A10, A15: ninguna allowance a terceros (Permit2, router, atacante, relayer) y ningún selector de autoridad; tras
    ///     cada swap la allowance al executor es 0 y una allowance residual no la usa un tercero.
    function invariant_A10_A15_noThirdPartyAuthority() public view {
        address[4] memory spenders = [ext.permit2, router02, handler.attacker(), handler.relayer()];
        for (uint256 i; i < spenders.length; ++i) {
            assertEq(usdc.allowance(address(safe), spenders[i]), 0, "allowance USDC a terceros");
            assertEq(usdt.allowance(address(safe), spenders[i]), 0, "allowance USDT a terceros");
        }
        assertEq(handler.thirdPartyApprovalSucceeded(), 0, "approve a terceros");
        assertEq(handler.authoritySelectorSucceeded(), 0, "selector de autoridad");
        assertEq(handler.allowanceLeftAfterSwap(), 0, "allowance despues del swap");
        assertEq(handler.residualAllowanceAbused(), 0, "allowance residual usada por un tercero");
    }

    /// A11: la Safe sigue verificando contra la factory y los roles del Guard coinciden con los owners.
    function invariant_A11_configurationIntact() public view {
        (bool ok, bytes32 reason) = sys.walletFactory.verifyWallet(address(safe));
        assertTrue(ok, string(abi.encodePacked(reason)));
        assertTrue(handler.rolesMatchOwners(), "roles del Guard != owners");
    }

    /// A12, A13: ninguna firma se reusa y un NoOp invalida la SafeTx pendiente de ese nonce.
    function invariant_A12_A13_noReplay() public view {
        assertEq(handler.replaySucceeded(), 0, "replay");
        assertEq(handler.pendingAfterNoOpSucceeded(), 0, "pendiente tras NoOp");
    }

    /// A16: sólo USDC↔USDT y el executor nunca retiene fondos.
    function invariant_A16_swapScope() public view {
        assertEq(handler.unsupportedSwapSucceeded(), 0, "swap de token no soportado");
        address ex = handler.swapExecutor();
        assertEq(usdc.balanceOf(ex), 0, "executor con USDC");
        assertEq(usdt.balanceOf(ex), 0, "executor con USDT");
    }

    /// A17: ninguna rotación asistida antes de 48 h ni sin propuesta.
    function invariant_A17_rotationsOnlyAfterDelay() public view {
        assertEq(handler.rotationBeforeDelay(), 0, "rotacion antes de 48 h");
        assertEq(handler.rotationWithoutProposal(), 0, "rotacion sin propuesta");
    }

    /// Conservación: los saldos de la Safe son exactamente los del modelo y el atacante sólo recibió lo que U+R le
    /// enviaron por camino soberano.
    function invariant_fundsAccounted() public view {
        assertEq(usdc.balanceOf(address(safe)), handler.expectedUsdc(), "USDC de la Safe");
        assertEq(usdt.balanceOf(address(safe)), handler.expectedUsdt(), "USDT de la Safe");
        assertEq(usdc.balanceOf(handler.attacker()), handler.sovereignToAttackerUsdc(), "USDC del atacante");
    }
}
