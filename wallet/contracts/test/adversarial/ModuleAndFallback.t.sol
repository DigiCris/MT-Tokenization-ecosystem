// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {AdversarialBase, ISafeAdmin} from "./AdversarialBase.sol";
import {Operation} from "../../src/interfaces/ISafe.sol";
import {DenyAllModuleGuard} from "../../src/DenyAllModuleGuard.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";

/// @notice Ejecución por módulo de Safe v1.5.0.
interface ISafeModuleExec {
    function execTransactionFromModule(address to, uint256 value, bytes memory data, Operation operation)
        external
        returns (bool success);
}

/// @notice Módulo que intenta vaciar la Safe por `execTransactionFromModule`.
contract DrainModule {
    function drain(address safe, address token, address to, uint256 amount) external returns (bool) {
        (bool ok, bytes memory ret) = safe.call(
            abi.encodeWithSignature(
                "execTransactionFromModule(address,uint256,bytes,uint8)",
                token,
                0,
                abi.encodeWithSignature("transfer(address,uint256)", to, amount),
                uint8(0)
            )
        );
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return abi.decode(ret, (bool));
    }
}

/// @notice P07.T01.c — ejecución por módulo y llamada al fallback (A8): sin módulo habilitado la Safe rechaza; con un
///         módulo habilitado por U+R, el `DenyAllModuleGuard` bloquea toda ejecución y el camino asistido queda en
///         fail-closed; sin fallback handler, una llamada al fallback no hace nada.
contract ModuleAndFallbackAttackTest is AdversarialBase {
    function test_moduleExecutionWithoutEnabledModuleFails() public {
        DrainModule m = new DrainModule();
        vm.expectRevert(bytes("GS104"));
        m.drain(address(safe), ext.usdc, attacker, 1e6);
        vm.prank(attacker);
        vm.expectRevert(bytes("GS104"));
        ISafeModuleExec(address(safe)).execTransactionFromModule(ext.usdc, 0, _transfer(attacker, 1e6), Operation.Call);
        _assertSafeUntouched();
    }

    function test_enabledModuleStillBlockedAndAssistedFailsClosed() public {
        DrainModule m = new DrainModule();
        assertTrue(_sovereign(_call(address(safe), abi.encodeCall(ISafeAdmin.enableModule, (address(m))))));
        vm.expectRevert(DenyAllModuleGuard.ModuleTransactionsDisabled.selector);
        m.drain(address(safe), ext.usdc, attacker, 1e6);
        // Con un módulo habilitado, el camino asistido no opera hasta que U+R restauren la configuración.
        _deny(userPk, ext.usdc, _transfer(dest, 1e6), SecurityGuard.SafeConfigurationAltered.selector);
        assertTrue(
            _sovereign(_call(address(safe), abi.encodeCall(ISafeAdmin.disableModule, (address(0x1), address(m)))))
        );
        assertTrue(_assisted(userPk, ext.usdc, _transfer(dest, 1e6)));
        assertEq(usdc.balanceOf(attacker), 0);
    }

    function test_assistedCannotEnableModuleOrFallback() public {
        _deny(
            userPk,
            address(safe),
            abi.encodeCall(ISafeAdmin.enableModule, (attacker)),
            SecurityGuard.AdminCallForbidden.selector
        );
        _deny(
            recoveryPk,
            address(safe),
            abi.encodeCall(ISafeAdmin.setFallbackHandler, (attacker)),
            SecurityGuard.AdminCallForbidden.selector
        );
        assertEq(_slot(FALLBACK_SLOT), address(0));
    }

    /// Sin fallback handler la llamada al fallback devuelve vacío y no cambia nada.
    function test_fallbackCallHasNoEffect() public {
        assertEq(_slot(FALLBACK_SLOT), address(0));
        vm.prank(attacker);
        (bool ok, bytes memory ret) =
            address(safe).call(abi.encodeWithSignature("simulate(address,bytes)", ext.usdc, _transfer(attacker, 1e6)));
        assertTrue(ok);
        assertEq(ret.length, 0);
        vm.prank(attacker);
        (ok, ret) = address(safe).call(abi.encodeWithSignature("isValidSignature(bytes32,bytes)", bytes32(0), ""));
        assertTrue(ok);
        assertEq(ret.length, 0);
        _assertSafeUntouched();
    }

    /// Un fallback handler instalado por U+R deja el camino asistido en fail-closed.
    function test_sovereignFallbackHandlerFailsClosed() public {
        assertTrue(
            _sovereign(
                _call(address(safe), abi.encodeCall(ISafeAdmin.setFallbackHandler, (ext.compatibilityFallbackHandler)))
            )
        );
        _deny(userPk, ext.usdc, _transfer(dest, 1e6), SecurityGuard.SafeConfigurationAltered.selector);
        _assertSafeUntouched();
    }
}
