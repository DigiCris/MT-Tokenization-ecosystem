// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {ISafe as OfficialISafe} from "@safe-global/safe-smart-account/contracts/interfaces/ISafe.sol";
import {IOwnerManager} from "@safe-global/safe-smart-account/contracts/interfaces/IOwnerManager.sol";
import {IModuleManager} from "@safe-global/safe-smart-account/contracts/interfaces/IModuleManager.sol";
import {IGuardManager} from "@safe-global/safe-smart-account/contracts/interfaces/IGuardManager.sol";
import {IStorageAccessible} from "@safe-global/safe-smart-account/contracts/interfaces/IStorageAccessible.sol";
import {
    ITransactionGuard as OfficialITransactionGuard
} from "@safe-global/safe-smart-account/contracts/base/GuardManager.sol";
import {IModuleGuard as OfficialIModuleGuard} from "@safe-global/safe-smart-account/contracts/base/ModuleManager.sol";
import {ForkTest} from "../utils/ForkTest.sol";
import {ISafe, ISafeProxyFactory} from "../../src/interfaces/ISafe.sol";
import {ITransactionGuard} from "../../src/interfaces/ITransactionGuard.sol";
import {IModuleGuard} from "../../src/interfaces/IModuleGuard.sol";

/// @notice P04.T01: las interfaces propias usan exactamente las firmas de Safe v1.5.0 (fuente oficial en el commit
///         fijado) y cada selector está en el bytecode desplegado en el fork.
contract SafeInterfaceSelectorsTest is ForkTest {
    function setUp() public {
        _fork();
    }

    function _selectors() internal pure returns (bytes4[17] memory ours, bytes4[17] memory official) {
        ours = [
            ISafe.setup.selector,
            ISafe.execTransaction.selector,
            ISafe.checkNSignatures.selector,
            ISafe.getTransactionHash.selector,
            ISafe.domainSeparator.selector,
            ISafe.nonce.selector,
            ISafe.getThreshold.selector,
            ISafe.getOwners.selector,
            ISafe.isOwner.selector,
            ISafe.approvedHashes.selector,
            ISafe.getStorageAt.selector,
            ISafe.getModulesPaginated.selector,
            ISafe.setGuard.selector,
            ISafe.setModuleGuard.selector,
            ISafe.swapOwner.selector,
            ISafe.approveHash.selector,
            bytes4(keccak256("VERSION()"))
        ];
        official = [
            OfficialISafe.setup.selector,
            OfficialISafe.execTransaction.selector,
            OfficialISafe.checkNSignatures.selector,
            OfficialISafe.getTransactionHash.selector,
            OfficialISafe.domainSeparator.selector,
            OfficialISafe.nonce.selector,
            IOwnerManager.getThreshold.selector,
            IOwnerManager.getOwners.selector,
            IOwnerManager.isOwner.selector,
            OfficialISafe.approvedHashes.selector,
            IStorageAccessible.getStorageAt.selector,
            IModuleManager.getModulesPaginated.selector,
            IGuardManager.setGuard.selector,
            IModuleManager.setModuleGuard.selector,
            IOwnerManager.swapOwner.selector,
            OfficialISafe.approveHash.selector,
            bytes4(keccak256("VERSION()"))
        ];
    }

    function test_selectorsMatchOfficialInterfaces() public pure {
        (bytes4[17] memory ours, bytes4[17] memory official) = _selectors();
        for (uint256 i; i < ours.length; ++i) {
            assertEq(ours[i], official[i]);
        }
        assertEq(type(ITransactionGuard).interfaceId, type(OfficialITransactionGuard).interfaceId);
        assertEq(type(ITransactionGuard).interfaceId, bytes4(0xe6d7a83a));
        assertEq(type(IModuleGuard).interfaceId, type(OfficialIModuleGuard).interfaceId);
        assertEq(type(IModuleGuard).interfaceId, bytes4(0x58401ed8));
        assertEq(
            ISafeProxyFactory.createProxyWithNonceL2.selector,
            bytes4(keccak256("createProxyWithNonceL2(address,bytes,uint256)"))
        );
        assertEq(ISafeProxyFactory.proxyCreationCode.selector, bytes4(keccak256("proxyCreationCode()")));
    }

    /// Cada selector aparece como PUSH4 en el dispatcher del singleton SafeL2 desplegado.
    function test_selectorsPresentInDeployedBytecode() public view {
        (bytes4[17] memory ours,) = _selectors();
        bytes memory code = ext.safeL2Singleton.code;
        for (uint256 i; i < ours.length; ++i) {
            assertTrue(_hasPush4(code, ours[i]), vm.toString(abi.encodePacked(ours[i])));
        }
        bytes memory factoryCode = ext.safeProxyFactory.code;
        assertTrue(_hasPush4(factoryCode, ISafeProxyFactory.createProxyWithNonceL2.selector));
        assertTrue(_hasPush4(factoryCode, ISafeProxyFactory.proxyCreationCode.selector));
    }

    function _hasPush4(bytes memory code, bytes4 sel) internal pure returns (bool) {
        for (uint256 i; i + 4 < code.length; ++i) {
            if (
                code[i] == 0x63
                    && bytes4(code[i + 1]) | (bytes4(code[i + 2]) >> 8) | (bytes4(code[i + 3]) >> 16)
                            | (bytes4(code[i + 4]) >> 24) == sel
            ) {
                return true;
            }
        }
        return false;
    }
}
