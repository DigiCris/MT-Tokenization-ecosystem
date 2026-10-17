// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeHelpers} from "../../utils/SafeHelpers.sol";
import {SafeOwners} from "../../utils/SafeOwners.sol";
import {SystemDeployer} from "../../../script/lib/SystemDeployer.sol";
import {ISafe, Operation} from "../../../src/interfaces/ISafe.sol";
import {IDestinationWhitelist} from "../../../src/interfaces/IDestinationWhitelist.sol";
import {IRotationTimelock} from "../../../src/interfaces/IRotationTimelock.sol";
import {ISecurityGuard} from "../../../src/interfaces/ISecurityGuard.sol";
import {SwapExecutorV3} from "../../../src/SwapExecutorV3.sol";
import {RotationKind} from "../../../src/libraries/Roles.sol";

/// @notice Handler de las invariantes de P07.T02. Actores: U, R y S de la Safe, un atacante y un relayer. Ejecuta
///         operaciones asistidas legítimas y abusivas, operaciones soberanas y avances de tiempo, y lleva un modelo
///         propio (whitelist con activación a 24 h, rotación con 48 h, saldos esperados) más contadores de violación:
///         cada ataque que **tuviera éxito** suma uno, y las invariantes exigen que todos queden en 0.
contract WalletHandler is SafeHelpers {
    using SafeOwners for ISafe;

    uint256 internal constant DEST_COUNT = 5;
    uint256 internal constant WHITELIST_DELAY = 24 hours;
    uint256 internal constant ROTATION_DELAY = 48 hours;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;

    ISafe public immutable safe;
    IERC20 public immutable usdc;
    IERC20 public immutable usdt;
    address public immutable permit2;
    address public immutable multiSend;
    SystemDeployer.Deployment internal sys;

    uint256 internal userPk;
    uint256 internal recoveryPk;
    uint256 public executorPk;
    address public executor;
    address public immutable attacker;
    address public immutable relayer;

    address[DEST_COUNT] public destinations;
    /// @notice Modelo de la whitelist: momento del alta (0 = no está).
    mapping(address => uint256) public addedAt;

    /// @notice Rotación de S pendiente en el modelo.
    address public pendingExecutor;
    uint256 internal pendingExecutorPk;
    uint256 public pendingSince;
    uint256 internal keyCounter;

    /// @notice Saldos esperados de la Safe según las operaciones exitosas.
    uint256 public expectedUsdc;
    uint256 public expectedUsdt;
    /// @notice Lo que U+R enviaron al atacante por camino soberano (única vía legítima).
    uint256 public sovereignToAttackerUsdc;

    /// @notice Última SafeTx asistida exitosa (para el replay).
    SafeTx internal lastTx;
    bytes internal lastSigs;
    bool internal hasLast;

    // Contadores de violación (todos deben quedar en 0).
    uint256 public assistedTransferToUnauthorized;
    uint256 public recoveryTransferSucceeded;
    uint256 public thirdPartyApprovalSucceeded;
    uint256 public authoritySelectorSucceeded;
    uint256 public allowanceLeftAfterSwap;
    uint256 public unsupportedSwapSucceeded;
    uint256 public gasParamsSucceeded;
    uint256 public delegateCallSucceeded;
    uint256 public singleKeySucceeded;
    uint256 public wrongSenderSucceeded;
    uint256 public replaySucceeded;
    uint256 public appendedSignatureBypass;
    uint256 public moduleExecutionSucceeded;
    uint256 public pendingAfterNoOpSucceeded;
    uint256 public rotationBeforeDelay;
    uint256 public rotationWithoutProposal;
    uint256 public sovereignFailures;
    uint256 public assistedWhileAlteredSucceeded;
    uint256 public residualAllowanceAbused;

    /// @notice Cantidad de operaciones exitosas por tipo (para verificar que la corrida ejercitó el sistema).
    uint256 public assistedTransfers;
    uint256 public swaps;
    uint256 public sovereignOps;
    uint256 public rotations;

    constructor(
        ISafe safe_,
        SystemDeployer.Deployment memory sys_,
        address usdc_,
        address usdt_,
        address permit2_,
        address multiSend_,
        uint256 userPk_,
        uint256 recoveryPk_,
        uint256 executorPk_
    ) {
        safe = safe_;
        sys = sys_;
        usdc = IERC20(usdc_);
        usdt = IERC20(usdt_);
        permit2 = permit2_;
        multiSend = multiSend_;
        userPk = userPk_;
        recoveryPk = recoveryPk_;
        executorPk = executorPk_;
        executor = vm.addr(executorPk_);
        attacker = makeAddr("inv-attacker");
        relayer = makeAddr("inv-relayer");
        for (uint256 i; i < DEST_COUNT; ++i) {
            destinations[i] = makeAddr(string.concat("inv-dest-", vm.toString(i)));
        }
        expectedUsdc = usdc.balanceOf(address(safe_));
        expectedUsdt = usdt.balanceOf(address(safe_));
    }

    // =============================================================================================
    // Ejecución sin revertir: devuelve si la SafeTx se ejecutó.

    function _try(address sender, SafeTx memory t, bytes memory sigs) internal returns (bool ok) {
        vm.prank(sender);
        (bool success, bytes memory ret) = address(safe)
            .call(
                abi.encodeCall(
                    ISafe.execTransaction,
                    (
                        t.to,
                        t.value,
                        t.data,
                        t.operation,
                        t.safeTxGas,
                        t.baseGas,
                        t.gasPrice,
                        t.gasToken,
                        payable(t.refundReceiver),
                        sigs
                    )
                )
            );
        ok = success && ret.length == 32 && abi.decode(ret, (bool));
    }

    function _signed(SafeTx memory t, uint256 a, uint256 b) internal view returns (bytes memory) {
        return _sigs(_txHash(safe, t, safe.nonce()), _pair(a, b));
    }

    function _assisted(uint256 cosignerPk, SafeTx memory t) internal returns (bool ok) {
        bytes memory sigs = _signed(t, cosignerPk, executorPk);
        ok = _try(executor, t, sigs);
        if (ok) {
            lastTx = t;
            lastSigs = sigs;
            hasLast = true;
        }
    }

    function _sovereign(SafeTx memory t) internal returns (bool ok) {
        ok = _try(relayer, t, _signed(t, userPk, recoveryPk));
        if (ok) ++sovereignOps;
        else ++sovereignFailures;
    }

    function _active(address d) internal view returns (bool) {
        return addedAt[d] != 0 && vm.getBlockTimestamp() >= addedAt[d] + WHITELIST_DELAY;
    }

    function _pick(uint256 seed) internal view returns (address) {
        uint256 i = seed % (DEST_COUNT + 2);
        if (i < DEST_COUNT) return destinations[i];
        return i == DEST_COUNT ? attacker : relayer;
    }

    function _token(bool isUsdc) internal view returns (IERC20) {
        return isUsdc ? usdc : usdt;
    }

    function _book(IERC20 token, uint256 out) internal {
        if (address(token) == address(usdc)) expectedUsdc -= out;
        else expectedUsdt -= out;
    }

    // =============================================================================================
    // Operaciones asistidas legítimas (pueden fallar por reglas; las exitosas se verifican contra el modelo).

    function warp(uint256 dt) external {
        vm.warp(vm.getBlockTimestamp() + bound(dt, 1, 3 days));
    }

    function whitelistAdd(uint256 seed) external {
        address d = destinations[seed % DEST_COUNT];
        if (addedAt[d] != 0) return;
        if (_assisted(
                userPk,
                _call(address(sys.destinationWhitelist), abi.encodeCall(IDestinationWhitelist.addDestination, (d)))
            )) {
            addedAt[d] = vm.getBlockTimestamp();
        }
    }

    function whitelistRemove(uint256 seed, bool byRecovery) external {
        address d = destinations[seed % DEST_COUNT];
        if (addedAt[d] == 0) return;
        if (_assisted(
                byRecovery ? recoveryPk : userPk,
                _call(address(sys.destinationWhitelist), abi.encodeCall(IDestinationWhitelist.removeDestination, (d)))
            )) {
            addedAt[d] = 0;
        }
    }

    function assistedTransfer(uint256 destSeed, uint256 amount, bool isUsdc, bool byRecovery) external {
        IERC20 token = _token(isUsdc);
        uint256 balance = token.balanceOf(address(safe));
        if (balance == 0) return;
        amount = bound(amount, 1, balance < 50e6 ? balance : 50e6);
        address d = _pick(destSeed);
        bool authorized = !byRecovery && _active(d);
        bool ok = _assisted(
            byRecovery ? recoveryPk : userPk, _call(address(token), abi.encodeCall(IERC20.transfer, (d, amount)))
        );
        if (ok) {
            ++assistedTransfers;
            _book(token, amount);
            if (!authorized) ++assistedTransferToUnauthorized;
            if (byRecovery) ++recoveryTransferSucceeded;
        }
    }

    /// Approve exacto + swap en dos SafeTx (o sólo el approve, que deja una allowance residual).
    function assistedSwap(bool usdcIn, uint256 amount, uint256 slippageBps, bool approveOnly) external {
        IERC20 tokenIn = _token(usdcIn);
        IERC20 tokenOut = _token(!usdcIn);
        uint256 balance = tokenIn.balanceOf(address(safe));
        if (balance < 1e6) return;
        amount = bound(amount, 1e6, balance < 100e6 ? balance : 100e6);
        address ex = address(sys.swapExecutor);
        if (!_assisted(userPk, _call(address(tokenIn), abi.encodeCall(IERC20.approve, (ex, amount))))) return;
        if (approveOnly) return;
        uint256 minOut = amount * (10_000 - bound(slippageBps, 0, 100)) / 10_000;
        uint256 inBefore = tokenIn.balanceOf(address(safe));
        uint256 outBefore = tokenOut.balanceOf(address(safe));
        bool ok = _assisted(
            userPk,
            _call(ex, abi.encodeCall(SwapExecutorV3.swap, (address(tokenIn), amount, minOut, vm.getBlockTimestamp())))
        );
        if (ok) {
            ++swaps;
            _book(tokenIn, inBefore - tokenIn.balanceOf(address(safe)));
            uint256 received = tokenOut.balanceOf(address(safe)) - outBefore;
            if (address(tokenOut) == address(usdc)) expectedUsdc += received;
            else expectedUsdt += received;
            if (tokenIn.allowance(address(safe), ex) != 0) ++allowanceLeftAfterSwap;
        } else {
            // swap rechazado (p. ej. slippage sobre el piso): U revoca la allowance.
            _assisted(userPk, _call(address(tokenIn), abi.encodeCall(IERC20.approve, (ex, 0))));
        }
    }

    function proposeExecutorRotation(uint256) external {
        if (pendingExecutor != address(0)) return;
        (address next, uint256 nextPk) = makeAddrAndKey(string.concat("inv-executor-", vm.toString(++keyCounter)));
        bool ok = _assisted(
            userPk,
            _call(
                address(sys.rotationTimelock),
                abi.encodeCall(IRotationTimelock.propose, (uint8(RotationKind.Executor), executor, next))
            )
        );
        if (ok) {
            pendingExecutor = next;
            pendingExecutorPk = nextPk;
            pendingSince = vm.getBlockTimestamp();
        }
    }

    function executeRotation() external {
        address target = pendingExecutor;
        bool hadProposal = target != address(0);
        if (!hadProposal) (target,) = makeAddrAndKey(string.concat("inv-unproposed-", vm.toString(++keyCounter)));
        bytes memory swapOwner = abi.encodeCall(ISafe.swapOwner, (safe.prevOwner(executor), executor, target));
        bool ok = _assisted(userPk, _call(address(safe), swapOwner));
        if (!ok) return;
        if (!hadProposal) {
            ++rotationWithoutProposal;
            return;
        }
        if (vm.getBlockTimestamp() < pendingSince + ROTATION_DELAY) ++rotationBeforeDelay;
        ++rotations;
        executorPk = pendingExecutorPk;
        executor = target;
        pendingExecutor = address(0);
    }

    function cancelRotationByRecovery() external {
        if (pendingExecutor == address(0)) return;
        bytes32 id = sys.rotationTimelock.activeProposal(address(safe), RotationKind.Executor);
        if (id == bytes32(0)) return;
        bytes memory sig = _ecdsa(recoveryPk, sys.rotationTimelock.cancelDigest(id));
        vm.prank(relayer);
        sys.rotationTimelock.cancelWithSignature(id, sig);
        pendingExecutor = address(0);
    }

    // =============================================================================================
    // Camino soberano (U+R): siempre debe ejecutarse.

    function sovereignTransfer(uint256 destSeed, uint256 amount, bool isUsdc) external {
        IERC20 token = _token(isUsdc);
        uint256 balance = token.balanceOf(address(safe));
        if (balance == 0) {
            _sovereign(_call(address(safe), ""));
            return;
        }
        amount = bound(amount, 1, balance < 20e6 ? balance : 20e6);
        address d = _pick(destSeed);
        if (_sovereign(_call(address(token), abi.encodeCall(IERC20.transfer, (d, amount))))) {
            _book(token, amount);
            if (d == attacker && isUsdc) sovereignToAttackerUsdc += amount;
        }
    }

    /// U+R reemplazan S directamente (`swapOwner` soberano); el Guard sincroniza el rol. Una propuesta asistida
    /// pendiente queda obsoleta (su `old` ya no es S) y sólo se puede cancelar.
    function sovereignRotateExecutor(uint256) external {
        (address next, uint256 nextPk) = makeAddrAndKey(string.concat("inv-sov-executor-", vm.toString(++keyCounter)));
        bytes memory swapOwner = abi.encodeCall(ISafe.swapOwner, (safe.prevOwner(executor), executor, next));
        if (_sovereign(_call(address(safe), swapOwner))) {
            executorPk = nextPk;
            executor = next;
        }
    }

    /// U+R habilitan un módulo: mientras esté, el camino asistido no opera; después lo deshabilitan.
    function sovereignModuleToggle(uint256) external {
        address module = makeAddr("inv-module");
        if (!_sovereign(_call(address(safe), abi.encodeWithSignature("enableModule(address)", module)))) return;
        if (_assisted(userPk, _call(address(safe), ""))) ++assistedWhileAlteredSucceeded;
        _sovereign(
            _call(address(safe), abi.encodeWithSignature("disableModule(address,address)", address(0x1), module))
        );
    }

    // =============================================================================================
    // Ataques: cada éxito es una violación.

    function attackSingleKey(uint256 which) external {
        uint256[3] memory keys = [userPk, recoveryPk, executorPk];
        SafeTx memory t = _call(address(usdc), abi.encodeCall(IERC20.transfer, (attacker, 1)));
        uint256[] memory one = new uint256[](1);
        one[0] = keys[which % 3];
        if (_try(executor, t, _sigs(_txHash(safe, t, safe.nonce()), one))) ++singleKeySucceeded;
    }

    function attackWrongSender(uint256 senderSeed) external {
        address sender = senderSeed % 2 == 0 ? attacker : relayer;
        SafeTx memory t = _call(address(safe), "");
        if (_try(sender, t, _signed(t, userPk, executorPk))) ++wrongSenderSucceeded;
    }

    function attackGasParams(uint256 which) external {
        SafeTx memory t = _call(address(safe), "");
        uint256 w = which % 5;
        if (w == 0) t.safeTxGas = 50_000;
        else if (w == 1) t.baseGas = 50_000;
        else if (w == 2) t.gasPrice = 1;
        else if (w == 3) t.gasToken = address(usdc);
        else t.refundReceiver = attacker;
        if (_try(executor, t, _signed(t, userPk, executorPk))) ++gasParamsSucceeded;
        SafeTx memory v = _call(attacker, "");
        v.value = 1;
        vm.deal(address(safe), 1);
        if (_try(executor, v, _signed(v, userPk, executorPk))) ++gasParamsSucceeded;
    }

    function attackDelegateCall() external {
        bytes memory batch = abi.encodePacked(
            uint8(0), address(usdc), uint256(0), uint256(68), abi.encodeCall(IERC20.transfer, (attacker, 1))
        );
        SafeTx memory t = _call(multiSend, abi.encodeWithSignature("multiSend(bytes)", batch));
        t.operation = Operation.DelegateCall;
        if (_try(executor, t, _signed(t, userPk, executorPk))) ++delegateCallSucceeded;
    }

    function attackReplay() external {
        if (!hasLast) return;
        if (_try(executor, lastTx, lastSigs)) ++replaySucceeded;
    }

    /// U+S válidas + firma de R anexada, hacia el atacante: el Guard no debe tratarla como soberana.
    function attackAppendedSignature(uint256 amount) external {
        uint256 balance = usdc.balanceOf(address(safe));
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        SafeTx memory t = _call(address(usdc), abi.encodeCall(IERC20.transfer, (attacker, amount)));
        bytes32 h = _txHash(safe, t, safe.nonce());
        bytes memory sigs = bytes.concat(_sigs(h, _pair(userPk, executorPk)), _ecdsa(recoveryPk, h));
        if (_try(executor, t, sigs)) {
            ++appendedSignatureBypass;
            expectedUsdc -= amount;
        }
    }

    function attackApproveThirdParty(uint256 seed) external {
        address[3] memory spenders = [permit2, attacker, relayer];
        SafeTx memory t = _call(address(usdc), abi.encodeCall(IERC20.approve, (spenders[seed % 3], 1)));
        if (_assisted(userPk, t)) ++thirdPartyApprovalSucceeded;
    }

    function attackAuthoritySelector(uint256 seed) external {
        bytes[4] memory calls = [
            abi.encodeWithSignature("transferFrom(address,address,uint256)", address(safe), attacker, 1),
            abi.encodeWithSignature("increaseAllowance(address,uint256)", attacker, 1),
            abi.encodeWithSignature(
                "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
                address(safe),
                attacker,
                1,
                1,
                uint8(27),
                bytes32(0),
                bytes32(0)
            ),
            abi.encodeWithSignature(
                "approve(address,address,uint160,uint48)", address(usdc), attacker, uint160(1), uint48(1)
            )
        ];
        uint256 i = seed % 4;
        address target = i == 3 ? permit2 : address(usdc);
        if (_assisted(userPk, _call(target, calls[i]))) ++authoritySelectorSucceeded;
    }

    function attackUnsupportedSwap(uint256 amount) external {
        amount = bound(amount, 1, 1e18);
        SafeTx memory t = _call(
            address(sys.swapExecutor),
            abi.encodeCall(SwapExecutorV3.swap, (WETH, amount, amount, vm.getBlockTimestamp()))
        );
        if (_assisted(userPk, t)) ++unsupportedSwapSucceeded;
    }

    function attackModuleExecution() external {
        vm.prank(attacker);
        (bool ok,) = address(safe)
            .call(
                abi.encodeWithSignature(
                    "execTransactionFromModule(address,uint256,bytes,uint8)",
                    address(usdc),
                    0,
                    abi.encodeCall(IERC20.transfer, (attacker, 1)),
                    uint8(0)
                )
            );
        if (ok) ++moduleExecutionSucceeded;
    }

    /// Con una allowance residual de la Safe al executor, el atacante intenta usarla.
    function attackResidualAllowance(uint256 amount) external {
        address ex = address(sys.swapExecutor);
        uint256 allowance = usdc.allowance(address(safe), ex);
        if (allowance == 0) return;
        uint256 before = usdc.balanceOf(address(safe));
        amount = bound(amount, 1, allowance);
        vm.prank(attacker);
        (bool ok,) = ex.call(abi.encodeCall(SwapExecutorV3.swap, (address(usdc), amount, 0, vm.getBlockTimestamp())));
        if (ok || usdc.balanceOf(address(safe)) != before) ++residualAllowanceAbused;
    }

    /// A13: SafeTx firmada para el nonce N, NoOp en N y luego la pendiente.
    function attackPendingAfterNoOp(bool byRecovery) external {
        SafeTx memory pending = _call(address(usdc), abi.encodeCall(IERC20.transfer, (attacker, 1)));
        bytes memory sigs = _signed(pending, userPk, executorPk);
        if (!_assisted(byRecovery ? recoveryPk : userPk, _call(address(safe), ""))) return;
        if (_try(executor, pending, sigs)) ++pendingAfterNoOpSucceeded;
    }

    // =============================================================================================

    /// @notice Owners de la Safe vs roles del Guard (mismo conjunto, threshold 2).
    function rolesMatchOwners() external view returns (bool) {
        address[] memory owners = safe.getOwners();
        if (owners.length != 3 || safe.getThreshold() != 2) return false;
        ISecurityGuard.SafeRoles memory r = sys.securityGuard.rolesOf(address(safe));
        for (uint256 i; i < 3; ++i) {
            if (owners[i] != r.userKey && owners[i] != r.recoveryKey && owners[i] != r.executor) return false;
        }
        return r.initialized && r.executor == executor;
    }

    function swapExecutor() external view returns (address) {
        return address(sys.swapExecutor);
    }
}
