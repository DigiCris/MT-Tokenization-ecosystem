// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SystemFixture} from "../utils/SystemFixture.sol";
import {ISafe, Operation} from "../../src/interfaces/ISafe.sol";
import {ISecurityGuard} from "../../src/interfaces/ISecurityGuard.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";
import {DenyAllModuleGuard} from "../../src/DenyAllModuleGuard.sol";
import {Role} from "../../src/libraries/Roles.sol";

interface ISafeOwners {
    function enableModule(address module) external;
    function disableModule(address prevModule, address module) external;
    function setFallbackHandler(address handler) external;
    function addOwnerWithThreshold(address owner, uint256 threshold) external;
    function removeOwner(address prevOwner, address owner, uint256 threshold) external;
    function changeThreshold(uint256 threshold) external;
}

interface IMultiSend {
    function multiSend(bytes memory transactions) external payable;
}

/// @notice P05.T06 (camino soberano) — A6: U+R opera sin backend ni S y sin políticas de negocio; el camino
///         soberano nunca revierte ([C-GRD-03] paso 3) y los cambios de configuración dejan el camino asistido
///         en fail-closed hasta que U+R los restauran ([C-GRD-03] paso 6).
contract SovereignPathTest is SystemFixture {
    address internal relayer;
    address internal anyone;
    IERC20 internal usdc;
    address internal constant SENTINEL = address(0x1);

    function setUp() public {
        _setUpSystem();
        relayer = makeAddr("relayer");
        anyone = makeAddr("anyone-not-whitelisted");
        usdc = IERC20(ext.usdc);
        _fund(ext.usdc, address(safe), 500e6);
    }

    function _sovereign(address to, bytes memory data) internal returns (bool) {
        return _exec(safe, relayer, _call(to, data), _pair(userPk, recoveryPk));
    }

    function _assistedNoOpReverts(bytes4 err) internal {
        _execExpectRevert(
            safe, executor, _call(address(safe), ""), _pair(userPk, executorPk), abi.encodeWithSelector(err)
        );
    }

    function test_transferToAnyAddressWithoutBackend() public {
        assertTrue(_sovereign(ext.usdc, abi.encodeCall(IERC20.transfer, (anyone, 123e6))));
        assertEq(usdc.balanceOf(anyone), 123e6);
        // Cualquier relayer puede transmitir; también un token no soportado o una llamada arbitraria.
        assertTrue(_sovereign(anyone, ""));
        assertTrue(_sovereign(ext.permit2, abi.encodeWithSignature("DOMAIN_SEPARATOR()")));
    }

    function test_removeGuard() public {
        assertTrue(_sovereign(address(safe), abi.encodeCall(ISafe.setGuard, (address(0)))));
        assertEq(
            address(
                uint160(
                    uint256(
                        bytes32(
                            safe.getStorageAt(
                                uint256(0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8), 1
                            )
                        )
                    )
                )
            ),
            address(0)
        );
        // Sin Guard la Safe sigue operando con 2 de 3, incluso U+S.
        assertTrue(
            _exec(
                safe,
                relayer,
                _call(ext.usdc, abi.encodeCall(IERC20.transfer, (anyone, 1e6))),
                _pair(userPk, executorPk)
            )
        );
    }

    /// Cambio de S por camino soberano: el Guard sincroniza el rol y el camino asistido sigue con la nueva S.
    function test_swapExecutorSovereignlySyncsRoles() public {
        (address newS, uint256 newSPk) = makeAddrAndKey("sovereign-new-s");
        address prev = _prevOwner(executor);
        assertTrue(_sovereign(address(safe), abi.encodeCall(ISafe.swapOwner, (prev, executor, newS))));
        ISecurityGuard.SafeRoles memory r = sys.securityGuard.rolesOf(address(safe));
        assertEq(r.executor, newS);
        assertEq(uint8(sys.securityGuard.roleOf(address(safe), newS)), uint8(Role.Executor));
        assertTrue(_exec(safe, newS, _call(address(safe), ""), _pair(userPk, newSPk)));
        // La S vieja ya no es owner: la Safe rechaza su firma.
        _execExpectRevert(safe, executor, _call(address(safe), ""), _pair(userPk, executorPk), bytes("GS026"));
    }

    function test_sovereignConfigChangesFailClosedUntilRestored() public {
        address module = makeAddr("module");
        // Módulo habilitado → asistido deshabilitado; al quitarlo, vuelve.
        assertTrue(_sovereign(address(safe), abi.encodeCall(ISafeOwners.enableModule, (module))));
        _assistedNoOpReverts(SecurityGuard.SafeConfigurationAltered.selector);
        assertTrue(_sovereign(address(safe), abi.encodeCall(ISafeOwners.disableModule, (SENTINEL, module))));
        assertTrue(_exec(safe, executor, _call(address(safe), ""), _pair(userPk, executorPk)));
        // Fallback handler.
        assertTrue(
            _sovereign(
                address(safe), abi.encodeCall(ISafeOwners.setFallbackHandler, (ext.compatibilityFallbackHandler))
            )
        );
        _assistedNoOpReverts(SecurityGuard.SafeConfigurationAltered.selector);
        assertTrue(_sovereign(address(safe), abi.encodeCall(ISafeOwners.setFallbackHandler, (address(0)))));
        assertTrue(_exec(safe, executor, _call(address(safe), ""), _pair(userPk, executorPk)));
        // Module guard reemplazado y quitado.
        DenyAllModuleGuard other = new DenyAllModuleGuard();
        assertTrue(_sovereign(address(safe), abi.encodeCall(ISafe.setModuleGuard, (address(other)))));
        _assistedNoOpReverts(SecurityGuard.SafeConfigurationAltered.selector);
        assertTrue(_sovereign(address(safe), abi.encodeCall(ISafe.setModuleGuard, (address(0)))));
        _assistedNoOpReverts(SecurityGuard.SafeConfigurationAltered.selector);
        assertTrue(_sovereign(address(safe), abi.encodeCall(ISafe.setModuleGuard, (address(sys.denyAllModuleGuard)))));
        assertTrue(_exec(safe, executor, _call(address(safe), ""), _pair(userPk, executorPk)));
    }

    function test_ownerAndThresholdChangesFailClosedThenUpdateRoles() public {
        address extra = makeAddr("extra-owner");
        assertTrue(_sovereign(address(safe), abi.encodeCall(ISafeOwners.addOwnerWithThreshold, (extra, 2))));
        _assistedNoOpReverts(SecurityGuard.SafeConfigurationAltered.selector);
        assertTrue(_sovereign(address(safe), abi.encodeCall(ISafeOwners.removeOwner, (_prevOwner(extra), extra, 2))));
        assertTrue(_exec(safe, executor, _call(address(safe), ""), _pair(userPk, executorPk)));
        // Threshold 1: U sola opera soberanamente; S sola no (el Guard exige threshold 2 en asistido).
        assertTrue(_sovereign(address(safe), abi.encodeCall(ISafeOwners.changeThreshold, (1))));
        uint256[] memory onlyU = new uint256[](1);
        onlyU[0] = userPk;
        assertTrue(_exec(safe, relayer, _call(address(safe), ""), onlyU));
        uint256[] memory onlyS = new uint256[](1);
        onlyS[0] = executorPk;
        _execExpectRevert(
            safe,
            executor,
            _call(address(safe), ""),
            onlyS,
            abi.encodeWithSelector(SecurityGuard.InvalidThreshold.selector)
        );
        assertTrue(_exec(safe, relayer, _call(address(safe), abi.encodeCall(ISafeOwners.changeThreshold, (2))), onlyU));
        assertTrue(_exec(safe, executor, _call(address(safe), ""), _pair(userPk, executorPk)));
    }

    /// [C-GRD-14]: updateRoles sólo la Safe registrada (por camino soberano), con owners actuales y distintos.
    function test_updateRolesSovereignly() public {
        assertTrue(
            _sovereign(
                address(sys.securityGuard), abi.encodeCall(SecurityGuard.updateRoles, (recoveryKey, userKey, executor))
            )
        );
        ISecurityGuard.SafeRoles memory r = sys.securityGuard.rolesOf(address(safe));
        assertEq(r.userKey, recoveryKey);
        assertEq(r.recoveryKey, userKey);
        assertEq(r.version, 2);
        bytes memory bad = abi.encodeCall(SecurityGuard.updateRoles, (makeAddr("no-owner"), userKey, executor));
        SafeTx memory t = _call(address(sys.securityGuard), bad);
        t.safeTxGas = 200_000; // con safeTxGas > 0 la Safe no revierte si falla la llamada interna
        assertFalse(_exec(safe, relayer, t, _pair(userPk, recoveryPk)));
        vm.expectRevert(SecurityGuard.UnregisteredSafe.selector);
        sys.securityGuard.updateRoles(userKey, recoveryKey, executor);
        vm.prank(address(safe));
        vm.expectRevert(SecurityGuard.InvalidKeys.selector);
        sys.securityGuard.updateRoles(userKey, userKey, executor);
        vm.prank(address(safe));
        vm.expectRevert(SecurityGuard.NotOwners.selector);
        sys.securityGuard.updateRoles(userKey, recoveryKey, makeAddr("no-owner"));
    }

    function test_multiSendDelegateCallPasses() public {
        bytes memory txs = abi.encodePacked(
            uint8(0),
            ext.usdc,
            uint256(0),
            uint256(68),
            abi.encodeCall(IERC20.transfer, (anyone, 2e6)),
            uint8(0),
            ext.usdc,
            uint256(0),
            uint256(68),
            abi.encodeCall(IERC20.transfer, (relayer, 3e6))
        );
        SafeTx memory t = _call(ext.multiSendCallOnly, abi.encodeCall(IMultiSend.multiSend, (txs)));
        t.operation = Operation.DelegateCall;
        assertTrue(_exec(safe, relayer, t, _pair(userPk, recoveryPk)));
        assertEq(usdc.balanceOf(anyone), 2e6);
        assertEq(usdc.balanceOf(relayer), 3e6);
    }

    function test_nestedSovereignExecTransactionPasses() public {
        SafeTx memory inner = _call(ext.usdc, abi.encodeCall(IERC20.transfer, (anyone, 4e6)));
        uint256 n = safe.nonce();
        // La tx interna se firma con el nonce n + 1 (la externa consume n antes de ejecutarla).
        bytes memory innerSigs = _sigs(_txHash(safe, inner, n + 1), _pair(userPk, recoveryPk));
        bytes memory data = abi.encodeCall(
            ISafe.execTransaction,
            (inner.to, 0, inner.data, Operation.Call, 0, 0, 0, address(0), payable(address(0)), innerSigs)
        );
        assertTrue(_sovereign(address(safe), data));
        assertEq(usdc.balanceOf(anyone), 4e6);
        assertEq(safe.nonce(), n + 2);
    }

    /// Una SafeTx asistida anidada dentro de una soberana revierte (una ejecución asistida por Safe a la vez).
    function test_nestedAssistedExecutionRejected() public {
        SafeTx memory inner = _call(address(safe), "");
        uint256 n = safe.nonce();
        bytes memory innerSigs = _sigs(_txHash(safe, inner, n + 1), _pair(userPk, executorPk));
        bytes memory data = abi.encodeCall(
            ISafe.execTransaction,
            (address(safe), 0, "", Operation.Call, 0, 0, 0, address(0), payable(address(0)), innerSigs)
        );
        // La Safe propaga el error de la tx interna (safeTxGas = 0).
        _execExpectRevert(
            safe,
            relayer,
            _call(address(safe), data),
            _pair(userPk, recoveryPk),
            abi.encodeWithSelector(SecurityGuard.ConcurrentExecution.selector)
        );
    }

    /// Con safeTxGas > 0 una llamada interna fallida no revierte la Safe: el Guard (soberano) tampoco.
    function test_failedInnerCallNeverRevertsInSovereignPath() public {
        SafeTx memory t = _call(ext.usdc, abi.encodeCall(IERC20.transfer, (anyone, 1_000_000e6)));
        t.safeTxGas = 200_000;
        assertFalse(_exec(safe, relayer, t, _pair(userPk, recoveryPk)));
    }

    function _prevOwner(address owner) internal view returns (address prev) {
        address[] memory owners = safe.getOwners();
        prev = SENTINEL;
        for (uint256 i; i < owners.length; ++i) {
            if (owners[i] == owner) return prev;
            prev = owners[i];
        }
        revert("no es owner");
    }
}
