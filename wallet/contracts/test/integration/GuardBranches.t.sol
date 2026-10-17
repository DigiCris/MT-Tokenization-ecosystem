// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SystemFixture} from "../utils/SystemFixture.sol";
import {SafeOwners} from "../utils/SafeOwners.sol";
import {ISafe, ISafeProxyFactory, Operation} from "../../src/interfaces/ISafe.sol";
import {ISecurityGuard} from "../../src/interfaces/ISecurityGuard.sol";
import {IRotationTimelock} from "../../src/interfaces/IRotationTimelock.sol";
import {ISwapExecutor} from "../../src/interfaces/ISwapExecutor.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";
import {PolicyRegistry} from "../../src/PolicyRegistry.sol";
import {Role, RotationKind} from "../../src/libraries/Roles.sol";

/// @dev Registro de "creación" para testear las validaciones de `initializeSafe` con Safes reales mal configuradas
///      (la WalletFactory real nunca las produce).
contract CreationRegistry {
    mapping(address => bool) public isCreating;

    function set(address safe, bool v) external {
        isCreating[safe] = v;
    }

    function isWallet(address) external pure returns (bool) {
        return false;
    }

    function SAFE_BOOTSTRAP() external pure returns (address) {
        return address(0);
    }
}

/// @dev Ejecutado por DELEGATECALL desde `Safe.setup`: arma la configuración pedida, llama a `initializeSafe` y
///      emite el resultado (el revert interno de setupModules se reemplaza por GS000, así que se captura aquí).
contract InitProbe {
    event InitResult(bytes err);

    struct Plan {
        address guard;
        address moduleGuard;
        bool installGuard;
        bool installModuleGuard;
        address module;
        address u;
        address r;
        address s;
        bool twice;
    }

    function run(Plan calldata p) external {
        if (p.installGuard) ISafe(address(this)).setGuard(p.guard);
        if (p.installModuleGuard) ISafe(address(this)).setModuleGuard(p.moduleGuard);
        if (p.module != address(0)) IModules(address(this)).enableModule(p.module);
        _init(p);
        if (p.twice) _init(p);
    }

    function _init(Plan calldata p) private {
        try ISecurityGuard(p.guard).initializeSafe(p.u, p.r, p.s) {
            emit InitResult("");
        } catch (bytes memory err) {
            emit InitResult(err);
        }
    }
}

/// @dev Se ejecuta por DELEGATECALL en el contexto de la Safe (`vm.prank(safe, true)`): checkTransaction y
///      checkAfterExecution en el mismo frame, como hace la Safe dentro de execTransaction.
contract PostCheckProbe {
    function run(SecurityGuard guard, bytes calldata sigs, address executor, bool success, address fallbackHandler)
        external
    {
        guard.checkTransaction(
            address(this), 0, "", Operation.Call, 0, 0, 0, address(0), payable(address(0)), sigs, executor
        );
        if (fallbackHandler != address(0)) {
            bytes32 slot = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;
            // solhint-disable-next-line no-inline-assembly
            assembly ("memory-safe") {
                sstore(slot, fallbackHandler)
            }
        }
        guard.checkAfterExecution(bytes32(0), success);
    }
}

interface IModules {
    function enableModule(address module) external;
}

/// @notice Ramas defensivas del `SecurityGuard` ([C-GRD-01], [C-GRD-03], [C-GRD-04], [C-GRD-14]).
contract GuardBranchesTest is SystemFixture {
    using SafeOwners for ISafe;

    CreationRegistry internal creation;
    SecurityGuard internal guardH;
    InitProbe internal probe;
    uint256 internal salt = 1000;

    function setUp() public {
        _setUpSystem();
        creation = new CreationRegistry();
        probe = new InitProbe();
        guardH = new SecurityGuard(
            address(sys.policyRegistry),
            address(sys.destinationWhitelist),
            address(sys.denyAllModuleGuard),
            address(creation),
            ext.safeL2Singleton,
            ext.proxyRuntimeCodehash,
            ext.permit2,
            address(0)
        );
    }

    function _plan() internal view returns (InitProbe.Plan memory p) {
        p = InitProbe.Plan({
            guard: address(guardH),
            moduleGuard: address(sys.denyAllModuleGuard),
            installGuard: true,
            installModuleGuard: true,
            module: address(0),
            u: userKey,
            r: recoveryKey,
            s: executor,
            twice: false
        });
    }

    /// Crea una Safe real con el plan dado y devuelve los errores que emitió `initializeSafe` (vacío = OK).
    function _initWith(
        InitProbe.Plan memory p,
        address singleton,
        address[] memory owners,
        uint256 threshold,
        address fallbackHandler,
        bool markCreating
    ) internal returns (bytes[] memory errs) {
        bytes memory init = abi.encodeCall(
            ISafe.setup,
            (
                owners,
                threshold,
                address(probe),
                abi.encodeCall(InitProbe.run, (p)),
                fallbackHandler,
                address(0),
                0,
                payable(address(0))
            )
        );
        bytes32 s = keccak256(abi.encodePacked(keccak256(init), ++salt));
        bytes memory creationCode = ISafeProxyFactory(ext.safeProxyFactory).proxyCreationCode();
        address predicted = vm.computeCreate2Address(
            s, keccak256(abi.encodePacked(creationCode, uint256(uint160(singleton)))), ext.safeProxyFactory
        );
        creation.set(predicted, markCreating);
        vm.recordLogs();
        ISafeProxyFactory(ext.safeProxyFactory).createProxyWithNonceL2(singleton, init, salt);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == InitProbe.InitResult.selector) ++n;
        }
        errs = new bytes[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == InitProbe.InitResult.selector) errs[n++] = abi.decode(logs[i].data, (bytes));
        }
    }

    function _owners() internal view returns (address[] memory o) {
        o = new address[](3);
        o[0] = userKey;
        o[1] = recoveryKey;
        o[2] = executor;
    }

    function _sel(bytes memory err) internal pure returns (bytes4) {
        return err.length >= 4 ? bytes4(err) : bytes4(0);
    }

    /// [C-GRD-01]: cada validación de `initializeSafe` con una Safe real mal configurada.
    function test_initializeSafeValidations() public {
        bytes[] memory e = _initWith(_plan(), ext.safeL2Singleton, _owners(), 2, address(0), true);
        assertEq(e[0].length, 0, "configuracion correcta");

        InitProbe.Plan memory p = _plan();
        p.twice = true;
        e = _initWith(p, ext.safeL2Singleton, _owners(), 2, address(0), true);
        assertEq(_sel(e[1]), SecurityGuard.AlreadyRegistered.selector);

        e = _initWith(_plan(), ext.safeL2Singleton, _owners(), 2, address(0), false);
        assertEq(_sel(e[0]), SecurityGuard.NotCreatedByFactory.selector);

        e = _initWith(_plan(), ext.safeSingleton, _owners(), 2, address(0), true);
        assertEq(_sel(e[0]), SecurityGuard.WrongSingleton.selector);

        p = _plan();
        p.r = userKey;
        e = _initWith(p, ext.safeL2Singleton, _owners(), 2, address(0), true);
        assertEq(_sel(e[0]), SecurityGuard.InvalidKeys.selector);

        p = _plan();
        p.s = makeAddr("no-owner");
        e = _initWith(p, ext.safeL2Singleton, _owners(), 2, address(0), true);
        assertEq(_sel(e[0]), SecurityGuard.OwnersMismatch.selector);

        e = _initWith(_plan(), ext.safeL2Singleton, _owners(), 1, address(0), true);
        assertEq(_sel(e[0]), SecurityGuard.ThresholdMismatch.selector);

        p = _plan();
        p.installGuard = false;
        e = _initWith(p, ext.safeL2Singleton, _owners(), 2, address(0), true);
        assertEq(_sel(e[0]), SecurityGuard.GuardNotInstalled.selector);

        p = _plan();
        p.installModuleGuard = false;
        e = _initWith(p, ext.safeL2Singleton, _owners(), 2, address(0), true);
        assertEq(_sel(e[0]), SecurityGuard.ModuleGuardNotInstalled.selector);

        e = _initWith(_plan(), ext.safeL2Singleton, _owners(), 2, ext.compatibilityFallbackHandler, true);
        assertEq(_sel(e[0]), SecurityGuard.FallbackHandlerSet.selector);

        p = _plan();
        p.module = makeAddr("module");
        e = _initWith(p, ext.safeL2Singleton, _owners(), 2, address(0), true);
        assertEq(_sel(e[0]), SecurityGuard.ModulesEnabled.selector);
    }

    function test_constructorRejectsZeroAddresses() public {
        address r = address(sys.policyRegistry);
        address w = address(sys.destinationWhitelist);
        address d = address(sys.denyAllModuleGuard);
        address f = address(sys.walletFactory);
        address l2 = ext.safeL2Singleton;
        bytes32 ch = ext.proxyRuntimeCodehash;
        address p2 = ext.permit2;
        vm.expectRevert(SecurityGuard.ZeroAddress.selector);
        new SecurityGuard(address(0), w, d, f, l2, ch, p2, address(0));
        vm.expectRevert(SecurityGuard.ZeroAddress.selector);
        new SecurityGuard(r, address(0), d, f, l2, ch, p2, address(0));
        vm.expectRevert(SecurityGuard.ZeroAddress.selector);
        new SecurityGuard(r, w, address(0), f, l2, ch, p2, address(0));
        vm.expectRevert(SecurityGuard.ZeroAddress.selector);
        new SecurityGuard(r, w, d, address(0), l2, ch, p2, address(0));
        vm.expectRevert(SecurityGuard.ZeroAddress.selector);
        new SecurityGuard(r, w, d, f, address(0), ch, p2, address(0));
        vm.expectRevert(SecurityGuard.ZeroAddress.selector);
        new SecurityGuard(r, w, d, f, l2, bytes32(0), p2, address(0));
        vm.expectRevert(SecurityGuard.ZeroAddress.selector);
        new SecurityGuard(r, w, d, f, l2, ch, address(0), address(0));
    }

    // ------------------------------------------------------------------------------------------
    // [C-GRD-04] con la Safe invocando al Guard directamente (estados que la Safe real no produce en el camino
    // asistido: ejecución fallida con safeTxGas = 0 y configuración alterada durante la ejecución).

    function _postCheck(bool success, address fallbackHandler) internal returns (bool ok, bytes memory ret) {
        assertTrue(_exec(safe, executor, _call(address(safe), ""), _pair(userPk, executorPk)));
        // Dentro del frame simulado la Safe no incrementa su nonce: el Guard usa nonce() - 1.
        bytes32 h = _txHash(safe, _call(address(safe), ""), safe.nonce() - 1);
        bytes memory sigs = _sigs(h, _pair(userPk, executorPk));
        PostCheckProbe probe2 = new PostCheckProbe();
        vm.prank(address(safe), true);
        (ok, ret) = address(probe2)
            .delegatecall(
                abi.encodeCall(PostCheckProbe.run, (sys.securityGuard, sigs, executor, success, fallbackHandler))
            );
    }

    function test_postCheckRejectsFailedExecution() public {
        (bool ok, bytes memory ret) = _postCheck(false, address(0));
        assertFalse(ok);
        assertEq(bytes4(ret), SecurityGuard.ExecutionFailed.selector);
    }

    function test_postCheckRejectsAlteredConfiguration() public {
        (bool ok, bytes memory ret) = _postCheck(true, ext.compatibilityFallbackHandler);
        assertFalse(ok);
        assertEq(bytes4(ret), SecurityGuard.SafeConfigurationAltered.selector);
    }

    function test_postCheckPassesWhenIntact() public {
        (bool ok,) = _postCheck(true, address(0));
        assertTrue(ok);
    }

    // ------------------------------------------------------------------------------------------
    // Cofirmante sin rol y sincronización soberana de un owner sin rol

    function test_ownerWithoutRoleCannotCosignAndIsNotSynced() public {
        (address extra, uint256 extraPk) = makeAddrAndKey("extra-owner");
        uint256[] memory ur = _pair(userPk, recoveryPk);
        assertTrue(
            _exec(
                safe,
                makeAddr("relayer"),
                _call(address(safe), abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", extra, 2)),
                ur
            )
        );
        _execExpectRevert(
            safe,
            executor,
            _call(address(safe), ""),
            _pair(extraPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.UnknownCosigner.selector)
        );
        // swapOwner soberano de un owner sin rol: el Guard no cambia ningún rol.
        (address extra2,) = makeAddrAndKey("extra-owner-2");
        bytes memory swap = abi.encodeCall(ISafe.swapOwner, (safe.prevOwner(extra), extra, extra2));
        assertTrue(_exec(safe, makeAddr("relayer"), _call(address(safe), swap), ur));
        ISecurityGuard.SafeRoles memory r = sys.securityGuard.rolesOf(address(safe));
        assertEq(r.userKey, userKey);
        assertEq(r.recoveryKey, recoveryKey);
        assertEq(r.executor, executor);
        assertEq(uint8(sys.securityGuard.roleOf(address(safe), address(0))), uint8(Role.None));
    }

    /// U rota R (propuesta de tipo Recovery) y ejecuta tras 48 h.
    function test_userRotatesRecoveryKey() public {
        (address newR,) = makeAddrAndKey("new-recovery");
        uint256 t0 = block.timestamp;
        assertTrue(
            _exec(
                safe,
                executor,
                _call(
                    address(sys.rotationTimelock),
                    abi.encodeCall(IRotationTimelock.propose, (uint8(RotationKind.Recovery), recoveryKey, newR))
                ),
                _pair(userPk, executorPk)
            )
        );
        vm.warp(t0 + 48 hours);
        bytes memory swap = abi.encodeCall(ISafe.swapOwner, (safe.prevOwner(recoveryKey), recoveryKey, newR));
        assertTrue(_exec(safe, executor, _call(address(safe), swap), _pair(userPk, executorPk)));
        assertEq(sys.securityGuard.rolesOf(address(safe)).recoveryKey, newR);
        // Propuesta de upgrade del Guard con un `old` que no es el Guard vigente.
        _execExpectRevert(
            safe,
            executor,
            _call(
                address(sys.rotationTimelock),
                abi.encodeCall(IRotationTimelock.propose, (uint8(RotationKind.Guard), makeAddr("otro"), makeAddr("x")))
            ),
            _pair(userPk, executorPk),
            abi.encodeWithSelector(SecurityGuard.RotationOldMismatch.selector)
        );
    }

    /// Estado no intacto visto por el pre-check (`evaluateAssisted`): guard retirado, threshold distinto y owners
    /// distintos de los roles.
    function test_evaluateAssistedReportsAlteredState() public {
        uint256[] memory ur = _pair(userPk, recoveryPk);
        ISafe s1 = _createWallet(userKey, recoveryKey, executor, 201);
        assertTrue(_exec(s1, makeAddr("relayer"), _call(address(s1), abi.encodeCall(ISafe.setGuard, (address(0)))), ur));
        (bool ok, bytes32 reason) = sys.securityGuard.evaluateAssisted(address(s1), Role.User, address(s1), 0, "");
        assertFalse(ok);
        assertEq(reason, bytes32(SecurityGuard.SafeConfigurationAltered.selector));
        ISafe s2 = _createWallet(userKey, recoveryKey, executor, 202);
        assertTrue(
            _exec(
                s2, makeAddr("relayer"), _call(address(s2), abi.encodeWithSignature("changeThreshold(uint256)", 3)), ur
            )
        );
        (, reason) = sys.securityGuard.evaluateAssisted(address(s2), Role.User, address(s2), 0, "");
        assertEq(reason, bytes32(SecurityGuard.SafeConfigurationAltered.selector));
        // Owners distintos de los roles: swapOwner hecho dentro de un MultiSend por DELEGATECALL (no se sincroniza).
        ISafe s3 = _createWallet(userKey, recoveryKey, executor, 203);
        (address otherS,) = makeAddrAndKey("unsynced-s");
        bytes memory swap = abi.encodeCall(ISafe.swapOwner, (s3.prevOwner(executor), executor, otherS));
        bytes memory txs = abi.encodePacked(uint8(0), address(s3), uint256(0), uint256(swap.length), swap);
        SafeTx memory t = _call(ext.multiSendCallOnly, abi.encodeWithSignature("multiSend(bytes)", txs));
        t.operation = Operation.DelegateCall;
        assertTrue(_exec(s3, makeAddr("relayer"), t, ur));
        assertEq(sys.securityGuard.rolesOf(address(s3)).executor, executor, "roles sin sincronizar");
        (, reason) = sys.securityGuard.evaluateAssisted(address(s3), Role.User, address(s3), 0, "");
        assertEq(reason, bytes32(SecurityGuard.SafeConfigurationAltered.selector));
    }

    /// evaluateAssisted devuelve motivo 0 cuando la clasificación revierte sin datos (executor sin código en BOOTSTRAP).
    function test_evaluateAssistedEmptyRevertReason() public {
        _deploySystem(PolicyRegistry.Mode.Bootstrap, true);
        ISafe b = _createWallet(userKey, recoveryKey, executor, 300);
        address eoaExecutor = makeAddr("eoa-executor");
        vm.prank(admin);
        sys.policyRegistry.setSwapExecutor(eoaExecutor, true);
        bytes memory swap = abi.encodeCall(ISwapExecutor.swap, (ext.usdc, 1e6, 1e6, block.timestamp + 1));
        (bool ok, bytes32 reason) = sys.securityGuard.evaluateAssisted(address(b), Role.User, eoaExecutor, 0, swap);
        assertFalse(ok);
        assertEq(reason, bytes32(0));
    }
}
