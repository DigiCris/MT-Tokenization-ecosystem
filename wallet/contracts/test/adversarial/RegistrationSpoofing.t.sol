// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {AdversarialBase} from "./AdversarialBase.sol";
import {ISafe, ISafeProxyFactory} from "../../src/interfaces/ISafe.sol";
import {ISecurityGuard} from "../../src/interfaces/ISecurityGuard.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";

/// @notice Contrato que imita las vistas de una Safe registrable (owners, threshold, slots y módulos correctos).
contract MimicSafe {
    address[] internal _owners;
    address internal immutable GUARD;
    address internal immutable DENY_ALL;
    address internal immutable SINGLETON;

    constructor(address[] memory owners_, address guard, address denyAll, address singleton) {
        _owners = owners_;
        GUARD = guard;
        DENY_ALL = denyAll;
        SINGLETON = singleton;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function getThreshold() external pure returns (uint256) {
        return 2;
    }

    function getStorageAt(uint256 offset, uint256) external view returns (bytes memory) {
        if (offset == 0) return abi.encode(SINGLETON);
        if (offset == uint256(0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8)) {
            return abi.encode(GUARD);
        }
        if (offset == uint256(0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947)) {
            return abi.encode(DENY_ALL);
        }
        return abi.encode(address(0));
    }

    function getModulesPaginated(address, uint256) external pure returns (address[] memory, address) {
        return (new address[](0), address(0x1));
    }

    function isOwner(address a) external view returns (bool) {
        for (uint256 i; i < _owners.length; ++i) {
            if (_owners[i] == a) return true;
        }
        return false;
    }

    function register(ISecurityGuard guard) external {
        guard.initializeSafe(_owners[0], _owners[1], _owners[2]);
    }
}

/// @notice P07.T01.p — suplantación de registro ([C-GRD-01]): un contrato que imita a una Safe, una Safe creada sin la
///         factory y el re-registro de una Safe ya registrada no consiguen roles en el Guard; tampoco se pueden
///         reescribir los roles de otra Safe.
contract RegistrationSpoofingAttackTest is AdversarialBase {
    function _spoofKeys() internal returns (address[] memory k) {
        k = new address[](3);
        k[0] = attacker;
        k[1] = makeAddr("rs-recovery");
        k[2] = makeAddr("rs-executor");
    }

    function test_mimicContractCannotRegister() public {
        MimicSafe mimic = new MimicSafe(
            _spoofKeys(), address(sys.securityGuard), address(sys.denyAllModuleGuard), ext.safeL2Singleton
        );
        vm.expectRevert(SecurityGuard.NotSafeProxy.selector);
        mimic.register(ISecurityGuard(address(sys.securityGuard)));
        assertFalse(sys.securityGuard.isRegistered(address(mimic)));
    }

    /// Safe real creada directo con la SafeProxyFactory y el `SafeBootstrap` del sistema (sin la WalletFactory).
    function test_safeCreatedOutsideFactoryCannotRegister() public {
        address[] memory k = _spoofKeys();
        bytes memory init = sys.walletFactory.initializerFor(k[0], k[1], k[2]);
        vm.prank(attacker);
        vm.expectRevert(bytes("GS000"));
        ISafeProxyFactory(ext.safeProxyFactory).createProxyWithNonceL2(ext.safeL2Singleton, init, 31);
        // La misma Safe por la WalletFactory sí queda registrada (el control es la marca de creación).
        address viaFactory = sys.walletFactory.createWallet(k[0], k[1], k[2], 31);
        assertTrue(sys.securityGuard.isRegistered(viaFactory));
    }

    /// Una Safe registrada no se re-registra con otras claves, ni siquiera llamando ella misma al Guard.
    function test_reRegistrationFails() public {
        vm.prank(address(safe));
        vm.expectRevert(SecurityGuard.NotCreatedByFactory.selector);
        sys.securityGuard.initializeSafe(attacker, recoveryKey, executor);
        ISecurityGuard.SafeRoles memory roles = sys.securityGuard.rolesOf(address(safe));
        assertEq(roles.userKey, userKey);
        assertEq(roles.recoveryKey, recoveryKey);
        assertEq(roles.executor, executor);
    }

    /// `updateRoles` sólo lo llama la Safe registrada: un tercero no reescribe los roles de otra.
    function test_thirdPartyCannotUpdateRoles() public {
        vm.prank(attacker);
        vm.expectRevert(SecurityGuard.UnregisteredSafe.selector);
        sys.securityGuard.updateRoles(attacker, recoveryKey, executor);
        vm.prank(address(safe));
        vm.expectRevert(SecurityGuard.NotOwners.selector);
        sys.securityGuard.updateRoles(attacker, recoveryKey, executor);
        assertEq(sys.securityGuard.rolesOf(address(safe)).userKey, userKey);
    }
}
