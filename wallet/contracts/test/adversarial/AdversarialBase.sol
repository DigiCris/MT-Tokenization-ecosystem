// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SystemFixture} from "../utils/SystemFixture.sol";
import {IDestinationWhitelist} from "../../src/interfaces/IDestinationWhitelist.sol";
import {ISafe, Operation} from "../../src/interfaces/ISafe.sol";
import {PolicyRegistry} from "../../src/PolicyRegistry.sol";

/// @notice Funciones administrativas de Safe v1.5.0 que la suite intenta abusar.
interface ISafeAdmin {
    function addOwnerWithThreshold(address owner, uint256 threshold) external;
    function removeOwner(address prevOwner, address owner, uint256 threshold) external;
    function swapOwner(address prevOwner, address oldOwner, address newOwner) external;
    function changeThreshold(uint256 threshold) external;
    function enableModule(address module) external;
    function disableModule(address prevModule, address module) external;
    function setFallbackHandler(address handler) external;
    function approveHash(bytes32 hashToApprove) external;
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
}

/// @notice `MultiSendCallOnly` de Safe v1.5.0.
interface IMultiSend {
    function multiSend(bytes memory transactions) external payable;
}

/// @notice Base de la suite adversarial (P07.T01): sistema completo sobre el fork en el modo de `POLICY_MODE`
///         (P07.T09), Safe real de U, R y S con 1.000 USDC y 1.000 USDT reales y un destino whitelisteado y activo.
///         Cada contrato de la suite demuestra que un ataque falla; el atacante tiene su propia clave y fondos.
abstract contract AdversarialBase is SystemFixture {
    uint256 internal constant SAFE_FUNDS = 1000e6;

    IERC20 internal usdc;
    IERC20 internal usdt;
    address internal dest;
    address internal attacker;
    uint256 internal attackerPk;
    uint256 internal t0;
    bool internal restricted;

    function setUp() public virtual {
        PolicyRegistry.Mode mode = _policyMode();
        restricted = mode == PolicyRegistry.Mode.Restricted;
        _setUpSystem(mode);
        usdc = IERC20(ext.usdc);
        usdt = IERC20(ext.usdt);
        (attacker, attackerPk) = makeAddrAndKey("mtw-attacker");
        dest = makeAddr("mtw-whitelisted-dest");
        t0 = block.timestamp;
        _fund(ext.usdc, address(safe), SAFE_FUNDS);
        _fund(ext.usdt, address(safe), SAFE_FUNDS);
        assertTrue(_assisted(userPk, address(sys.destinationWhitelist), _addDestination(dest)));
        vm.warp(t0 + 24 hours);
        assertTrue(sys.destinationWhitelist.isWhitelisted(address(safe), dest));
    }

    /// @notice SafeTx asistida firmada por `cosignerPk` + S y transmitida por S.
    function _assisted(uint256 cosignerPk, address to, bytes memory data) internal returns (bool) {
        return _exec(safe, executor, _call(to, data), _pair(cosignerPk, executorPk));
    }

    function _deny(uint256 cosignerPk, address to, bytes memory data, bytes4 err) internal {
        _denyTx(_call(to, data), cosignerPk, err);
    }

    function _denyTx(SafeTx memory t, uint256 cosignerPk, bytes4 err) internal {
        _execExpectRevert(safe, executor, t, _pair(cosignerPk, executorPk), abi.encodeWithSelector(err));
    }

    /// @notice Camino soberano: U+R firman y transmite cualquiera (aquí, el atacante como relayer).
    function _sovereign(SafeTx memory t) internal returns (bool) {
        return _exec(safe, attacker, t, _pair(userPk, recoveryPk));
    }

    function _transfer(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.transfer, (to, amount));
    }

    function _addDestination(address d) internal pure returns (bytes memory) {
        return abi.encodeCall(IDestinationWhitelist.addDestination, (d));
    }

    function _removeDestination(address d) internal pure returns (bytes memory) {
        return abi.encodeCall(IDestinationWhitelist.removeDestination, (d));
    }

    /// @notice SafeTx completa (con parámetros de gas y operación explícitos).
    function _safeTx(
        address to,
        uint256 value,
        bytes memory data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver
    ) internal pure returns (SafeTx memory t) {
        t = SafeTx(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver);
    }

    /// @notice Una transacción empaquetada para `MultiSend` (`operation ‖ to ‖ value ‖ len ‖ data`).
    function _packed(uint8 operation, address to, uint256 value, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(operation, to, value, data.length, data);
    }

    /// @notice Saldos de la Safe intactos: el ataque no movió fondos.
    function _assertSafeUntouched() internal view {
        assertEq(usdc.balanceOf(address(safe)), SAFE_FUNDS, "USDC de la Safe");
        assertEq(usdt.balanceOf(address(safe)), SAFE_FUNDS, "USDT de la Safe");
    }

    function _slot(bytes32 slot) internal view returns (address) {
        return address(uint160(uint256(bytes32(safe.getStorageAt(uint256(slot), 1)))));
    }

    bytes32 internal constant GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 internal constant MODULE_GUARD_SLOT = 0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;
    bytes32 internal constant FALLBACK_SLOT = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;
}
