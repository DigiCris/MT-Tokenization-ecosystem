// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {AdversarialBase, ISafeAdmin, IMultiSend} from "./AdversarialBase.sol";
import {ISafe, Operation} from "../../src/interfaces/ISafe.sol";

/// @notice P07.T01.q — el Guard nunca bloquea el camino soberano (A6): con las firmas válidas de U+R pasan
///         `setGuard(0)`, `setModuleGuard(0)`, MultiSend por DELEGATECALL, `execTransaction` anidado, parámetros de gas,
///         tipos de firma no ECDSA y transferencias a cualquier destino, aunque las transmita S o el atacante y aunque
///         el camino asistido esté en fail-closed.
contract SovereignNeverBlockedTest is AdversarialBase {
    function test_transferToAnyDestination() public {
        assertTrue(_sovereign(_call(ext.usdc, _transfer(attacker, 10e6))));
        assertTrue(_sovereign(_call(ext.usdt, _transfer(makeAddr("cualquiera"), 10e6))));
        assertEq(usdc.balanceOf(attacker), 10e6);
    }

    function test_removeGuardAndModuleGuard() public {
        assertTrue(_sovereign(_call(address(safe), abi.encodeCall(ISafe.setModuleGuard, (address(0))))));
        assertTrue(_sovereign(_call(address(safe), abi.encodeCall(ISafe.setGuard, (address(0))))));
        assertEq(_slot(GUARD_SLOT), address(0));
        assertEq(_slot(MODULE_GUARD_SLOT), address(0));
        assertTrue(_sovereign(_call(ext.usdc, _transfer(dest, 1e6))));
    }

    function test_multiSendDelegateCall() public {
        bytes memory batch = bytes.concat(
            _packed(0, ext.usdc, 0, _transfer(attacker, 1e6)),
            _packed(0, address(safe), 0, abi.encodeCall(ISafeAdmin.enableModule, (makeAddr("module"))))
        );
        SafeTx memory t = _safeTx(
            ext.multiSendCallOnly,
            0,
            abi.encodeCall(IMultiSend.multiSend, (batch)),
            Operation.DelegateCall,
            0,
            0,
            0,
            address(0),
            address(0)
        );
        assertTrue(_sovereign(t));
        assertEq(usdc.balanceOf(attacker), 1e6);
    }

    /// `execTransaction` anidado: la SafeTx externa (U+R) ejecuta una interna también de U+R.
    function test_nestedExecTransaction() public {
        uint256 n = safe.nonce();
        SafeTx memory inner = _call(ext.usdc, _transfer(attacker, 2e6));
        bytes memory innerSigs = _sigs(_txHash(safe, inner, n + 1), _pair(userPk, recoveryPk));
        bytes memory outerData = abi.encodeCall(
            ISafe.execTransaction,
            (inner.to, 0, inner.data, Operation.Call, 0, 0, 0, address(0), payable(address(0)), innerSigs)
        );
        assertTrue(_sovereign(_call(address(safe), outerData)));
        assertEq(usdc.balanceOf(attacker), 2e6);
        assertEq(safe.nonce(), n + 2);
    }

    /// Parámetros de gas, refund, `value` y firmas no ECDSA: decisiones de U+R, el Guard no las frena.
    function test_gasParamsValueAndSignatureTypes() public {
        vm.deal(address(safe), 1 ether);
        assertTrue(_sovereign(_safeTx(attacker, 0.1 ether, "", Operation.Call, 0, 0, 0, address(0), address(0))));
        SafeTx memory t = _call(ext.usdc, _transfer(dest, 1e6));
        bytes32 h = _txHash(safe, t, safe.nonce());
        bytes memory u = _ethSign(userPk, h);
        bytes memory r = _approvedHashSig(recoveryKey);
        bytes memory sigs = userKey < recoveryKey ? bytes.concat(u, r) : bytes.concat(r, u);
        assertTrue(_execRaw(safe, recoveryKey, t, sigs));
        assertEq(usdc.balanceOf(dest), 1e6);
    }

    /// S o el atacante como relayer de una SafeTx U+R: sigue siendo soberana.
    function test_anyRelayerIncludingExecutor() public {
        SafeTx memory t = _call(ext.usdc, _transfer(makeAddr("x"), 1e6));
        assertTrue(_exec(safe, executor, t, _pair(userPk, recoveryPk)));
        assertTrue(_exec(safe, attacker, _call(address(safe), ""), _pair(userPk, recoveryPk)));
    }

    /// Con el camino asistido en fail-closed (fallback instalado), U+R siguen operando y lo pueden restaurar.
    function test_sovereignWorksWhileAssistedFailsClosed() public {
        assertTrue(
            _sovereign(
                _call(address(safe), abi.encodeCall(ISafeAdmin.setFallbackHandler, (ext.compatibilityFallbackHandler)))
            )
        );
        assertFalse(_tryAssisted());
        assertTrue(_sovereign(_call(ext.usdc, _transfer(attacker, 1e6))));
        assertTrue(_sovereign(_call(address(safe), abi.encodeCall(ISafeAdmin.setFallbackHandler, (address(0))))));
        assertTrue(_tryAssisted());
    }

    function _tryAssisted() internal returns (bool ok) {
        SafeTx memory t = _call(address(safe), "");
        bytes memory sigs = _sigs(_txHash(safe, t, safe.nonce()), _pair(userPk, executorPk));
        vm.prank(executor);
        try safe.execTransaction(
            t.to, 0, t.data, Operation.Call, 0, 0, 0, address(0), payable(address(0)), sigs
        ) returns (
            bool success
        ) {
            ok = success;
        } catch {
            ok = false;
        }
    }
}
