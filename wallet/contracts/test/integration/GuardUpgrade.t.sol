// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SystemFixture} from "../utils/SystemFixture.sol";
import {IDestinationWhitelist} from "../../src/interfaces/IDestinationWhitelist.sol";
import {ISafe, ISafeProxyFactory} from "../../src/interfaces/ISafe.sol";
import {ISecurityGuard} from "../../src/interfaces/ISecurityGuard.sol";
import {IRotationTimelock} from "../../src/interfaces/IRotationTimelock.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";
import {DenyAllModuleGuard} from "../../src/DenyAllModuleGuard.sol";
import {RotationKind} from "../../src/libraries/Roles.sol";

/// @notice Singleton que no es una Safe: responde cualquier llamada con un `bytes` ABI-encoded malformado
///         (`offset`, `length` y una palabra en cero), como podría hacerlo un `SafeProxy` con una implementación hostil.
contract MalformedReturnSingleton {
    uint256 internal immutable OFFSET;
    uint256 internal immutable LENGTH;
    uint256 internal immutable SIZE;

    constructor(uint256 offset, uint256 length, uint256 size) {
        OFFSET = offset;
        LENGTH = length;
        SIZE = size;
    }

    fallback() external {
        uint256 offset = OFFSET;
        uint256 length = LENGTH;
        uint256 size = SIZE;
        assembly ("memory-safe") {
            mstore(0, offset)
            mstore(32, length)
            mstore(64, 0)
            return(0, size)
        }
    }
}

/// @notice P05.T06 (upgrade) — [C-GRD-17], [C-POL-06] y ADR-029: sucesor registrado (24 h + guardianes) + propuesta
///         por Safe en el timelock (48 h, cancelable por U o R) + SafeTx asistida U+S `setGuard`/`setModuleGuard`.
///         El sucesor es un `SecurityGuard` real que importa los roles del anterior en su primer uso.
contract GuardUpgradeTest is SystemFixture {
    SecurityGuard internal v2;
    DenyAllModuleGuard internal denyAll2;
    uint256 internal t0;

    bytes32 internal constant GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 internal constant MODULE_GUARD_SLOT = 0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;

    event RolesImported(
        address indexed safe, address indexed predecessor, address userKey, address recoveryKey, address executor
    );

    function setUp() public {
        _setUpSystem();
        t0 = block.timestamp;
        v2 = new SecurityGuard(
            address(sys.policyRegistry),
            address(sys.destinationWhitelist),
            address(sys.denyAllModuleGuard),
            makeAddr("factory-v2"),
            ext.safeL2Singleton,
            ext.proxyRuntimeCodehash,
            ext.permit2,
            address(sys.securityGuard)
        );
        denyAll2 = new DenyAllModuleGuard();
    }

    function _assisted(uint256 cosignerPk, address to, bytes memory data) internal returns (bool) {
        return _exec(safe, executor, _call(to, data), _pair(cosignerPk, executorPk));
    }

    function _deny(uint256 cosignerPk, address to, bytes memory data, bytes4 err) internal {
        _execExpectRevert(safe, executor, _call(to, data), _pair(cosignerPk, executorPk), abi.encodeWithSelector(err));
    }

    function _slot(bytes32 slot) internal view returns (address) {
        return address(uint160(uint256(bytes32(safe.getStorageAt(uint256(slot), 1)))));
    }

    function _registerSuccessorGuard() internal {
        vm.prank(admin);
        bytes32 id = sys.policyRegistry.proposeSuccessorGuard(address(sys.securityGuard), address(v2));
        vm.warp(t0 + 24 hours);
        sys.policyRegistry.activateChange(id);
    }

    function _proposeGuard(RotationKind kind, address oldV, address newV) internal returns (bytes32) {
        assertTrue(
            _assisted(
                userPk,
                address(sys.rotationTimelock),
                abi.encodeCall(IRotationTimelock.propose, (uint8(kind), oldV, newV))
            )
        );
        return sys.rotationTimelock.activeProposal(address(safe), kind);
    }

    function test_upgradeRequiresRegisteredSuccessor() public {
        bytes memory propose = abi.encodeCall(
            IRotationTimelock.propose, (uint8(RotationKind.Guard), address(sys.securityGuard), address(v2))
        );
        _deny(userPk, address(sys.rotationTimelock), propose, SecurityGuard.GuardUpgradeNotAuthorized.selector);
        _deny(
            userPk,
            address(safe),
            abi.encodeCall(ISafe.setGuard, (address(v2))),
            SecurityGuard.GuardUpgradeNotAuthorized.selector
        );
    }

    function test_upgradeRequiresMatureUncancelledProposalAndUser() public {
        _registerSuccessorGuard();
        _deny(
            recoveryPk,
            address(sys.rotationTimelock),
            abi.encodeCall(
                IRotationTimelock.propose, (uint8(RotationKind.Guard), address(sys.securityGuard), address(v2))
            ),
            SecurityGuard.RoleNotAllowed.selector
        );
        bytes32 id = _proposeGuard(RotationKind.Guard, address(sys.securityGuard), address(v2));
        uint256 proposedAt = t0 + 24 hours;
        vm.warp(proposedAt + 48 hours - 1);
        _deny(
            userPk,
            address(safe),
            abi.encodeCall(ISafe.setGuard, (address(v2))),
            SecurityGuard.GuardUpgradeNotAuthorized.selector
        );
        // Cancelada por R (firma EIP-712).
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(recoveryPk, sys.rotationTimelock.cancelDigest(id));
        sys.rotationTimelock.cancelWithSignature(id, abi.encodePacked(r, s, v));
        vm.warp(proposedAt + 72 hours);
        _deny(
            userPk,
            address(safe),
            abi.encodeCall(ISafe.setGuard, (address(v2))),
            SecurityGuard.GuardUpgradeNotAuthorized.selector
        );
        // R nunca ejecuta un upgrade.
        _deny(
            recoveryPk,
            address(safe),
            abi.encodeCall(ISafe.setGuard, (address(v2))),
            SecurityGuard.RoleNotAllowed.selector
        );
    }

    /// Upgrade completo: el slot apunta al sucesor y el sucesor importa los roles en su primer uso.
    function test_completeGuardUpgradeAndRoleImport() public {
        _registerSuccessorGuard();
        bytes32 id = _proposeGuard(RotationKind.Guard, address(sys.securityGuard), address(v2));
        vm.warp(t0 + 24 hours + 48 hours);
        assertTrue(_assisted(userPk, address(safe), abi.encodeCall(ISafe.setGuard, (address(v2)))));
        assertEq(_slot(GUARD_SLOT), address(v2));
        assertEq(uint8(sys.rotationTimelock.getProposal(id).status), uint8(IRotationTimelock.Status.Executed));
        // Vistas del sucesor antes del primer uso: roles del predecesor.
        assertTrue(v2.isRegistered(address(safe)));
        assertEq(v2.rolesOf(address(safe)).userKey, userKey);
        // Primer uso (camino asistido): importa los roles y opera.
        vm.expectEmit(address(v2));
        emit RolesImported(address(safe), address(sys.securityGuard), userKey, recoveryKey, executor);
        assertTrue(_assisted(userPk, address(safe), ""));
        ISecurityGuard.SafeRoles memory imported = v2.rolesOf(address(safe));
        assertEq(imported.executor, executor);
        assertEq(imported.version, 2);
        // El camino soberano también funciona con el sucesor.
        assertTrue(_exec(safe, makeAddr("relayer"), _call(address(safe), ""), _pair(userPk, recoveryPk)));
        // El Guard anterior ya no gobierna esta Safe.
        assertEq(v2.PREDECESSOR(), address(sys.securityGuard));
    }

    /// Upgrade del module guard: tras activarse, el estado sigue intacto con el sucesor activo.
    function test_completeModuleGuardUpgrade() public {
        vm.prank(admin);
        bytes32 reg = sys.policyRegistry.proposeSuccessorModuleGuard(address(sys.denyAllModuleGuard), address(denyAll2));
        vm.warp(t0 + 24 hours);
        sys.policyRegistry.activateChange(reg);
        _proposeGuard(RotationKind.ModuleGuard, address(sys.denyAllModuleGuard), address(denyAll2));
        vm.warp(t0 + 24 hours + 48 hours);
        assertTrue(_assisted(userPk, address(safe), abi.encodeCall(ISafe.setModuleGuard, (address(denyAll2)))));
        assertEq(_slot(MODULE_GUARD_SLOT), address(denyAll2));
        // El camino asistido sigue operativo con el sucesor activo...
        assertTrue(_assisted(userPk, address(safe), ""));
        // ...y queda en fail-closed si los guardianes revocan el sucesor.
        vm.prank(guardian1);
        sys.policyRegistry.revokeSuccessorModuleGuard(address(sys.denyAllModuleGuard));
        _deny(userPk, address(safe), "", SecurityGuard.SafeConfigurationAltered.selector);
    }

    /// Un Guard sin predecesor (V1) nunca importa: una Safe que lo instale sin estar registrada no opera.
    function test_noImportWithoutPredecessor() public {
        assertEq(sys.securityGuard.PREDECESSOR(), address(0));
        assertFalse(sys.securityGuard.isRegistered(makeAddr("x")));
    }

    /// La lectura del slot de guard de un `SafeProxy` con un singleton que no es una Safe nunca revierte: revert del
    /// singleton, retorno corto, offset o longitud inválidos → sin roles que importar.
    function test_successorReadsForeignProxiesWithoutReverting() public {
        address[4] memory singletons = [
            ext.permit2,
            address(new MalformedReturnSingleton(32, 32, 64)),
            address(new MalformedReturnSingleton(64, 32, 96)),
            address(new MalformedReturnSingleton(32, 31, 96))
        ];
        for (uint256 i; i < singletons.length; ++i) {
            address proxy = ISafeProxyFactory(ext.safeProxyFactory).createProxyWithNonceL2(singletons[i], "", 900 + i);
            assertEq(proxy.codehash, ext.proxyRuntimeCodehash, "SafeProxy canonico");
            assertFalse(v2.isRegistered(proxy));
            assertEq(uint8(v2.roleOf(proxy, userKey)), 0);
        }
    }

    /// El sucesor no importa roles de una Safe que no lo instaló.
    function test_successorIgnoresSafesThatDidNotInstallIt() public view {
        assertFalse(v2.isRegistered(address(safe)));
        assertEq(uint8(v2.roleOf(address(safe), userKey)), 0);
    }

    /// Tras el upgrade, el sucesor clasifica operaciones completas (transfer con whitelist). Variantes del getter
    /// SAFE_BOOTSTRAP de su factory: sin código (v2) o con código sin ese getter (v3, la factory es el registry).
    function _upgradeTo(SecurityGuard successor) internal {
        vm.prank(admin);
        bytes32 id = sys.policyRegistry.proposeSuccessorGuard(address(sys.securityGuard), address(successor));
        vm.warp(t0 + 24 hours);
        sys.policyRegistry.activateChange(id);
        _proposeGuard(RotationKind.Guard, address(sys.securityGuard), address(successor));
        vm.warp(t0 + 24 hours + 48 hours);
        assertTrue(_assisted(userPk, address(safe), abi.encodeCall(ISafe.setGuard, (address(successor)))));
    }

    function _transferThrough() internal {
        address dest = makeAddr("dest-after-upgrade");
        _fund(ext.usdc, address(safe), 10e6);
        assertTrue(
            _assisted(
                userPk, address(sys.destinationWhitelist), abi.encodeCall(IDestinationWhitelist.addDestination, (dest))
            )
        );
        vm.warp(block.timestamp + 24 hours);
        assertTrue(_assisted(userPk, ext.usdc, abi.encodeCall(IERC20.transfer, (dest, 1e6))));
        assertEq(IERC20(ext.usdc).balanceOf(dest), 1e6);
    }

    function test_successorWithFactoryWithoutCode() public {
        _upgradeTo(v2);
        _transferThrough();
    }

    function test_successorWithFactoryWithoutBootstrapGetter() public {
        SecurityGuard v3 = new SecurityGuard(
            address(sys.policyRegistry),
            address(sys.destinationWhitelist),
            address(sys.denyAllModuleGuard),
            address(sys.policyRegistry),
            ext.safeL2Singleton,
            ext.proxyRuntimeCodehash,
            ext.permit2,
            address(sys.securityGuard)
        );
        _upgradeTo(v3);
        _transferThrough();
    }
}
