// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SystemFixture} from "../utils/SystemFixture.sol";
import {SafeOwners} from "../utils/SafeOwners.sol";
import {ISafe, ISafeProxyFactory, Operation} from "../../src/interfaces/ISafe.sol";
import {IDestinationWhitelist} from "../../src/interfaces/IDestinationWhitelist.sol";
import {IRotationTimelock} from "../../src/interfaces/IRotationTimelock.sol";
import {SwapExecutorV3} from "../../src/SwapExecutorV3.sol";
import {RotationKind} from "../../src/libraries/Roles.sol";

/// @notice P07.T05 — vectores cruzados en `test/vectors/*.json` para backend, signer, Wallet y Recovery: SafeTxHash
///         por tipo de operación (calculado por la Safe real del fork), calldata, firmas EIP-712 de ejemplo, direcciones
///         CREATE2 predichas, typed data de `CancelRotation` y, en `wire/eip712.json`, los tipos EIP-712 de plataforma
///         de [W-01]. Los demás formatos de §7.15 ([W-02]–[W-07]) los genera `script/wire-vectors.mjs`. Las claves de
///         test se derivan como en forge-std (`clave = keccak256(label)`), así que los vectores sólo publican labels y
///         direcciones.
/// @dev Con `EXPORT_VECTORS=1` (lo hace `script/export-vectors.sh`) escribe los archivos; si no, exige que los
///      commiteados coincidan con lo que produce el código actual.
contract VectorsTest is SystemFixture {
    using SafeOwners for ISafe;

    string internal constant DIR = "/test/vectors/";
    uint256 internal constant DEADLINE = 1_792_192_947; // timestamp del bloque de fork + 1 h

    address internal dest;
    address internal newExecutor;
    address internal newSafe;
    address internal successor;
    bytes32 internal proposalId;

    struct Op {
        string name;
        address to;
        bytes data;
    }

    function setUp() public {
        _setUpSystem();
        dest = makeAddr("mtw-vector-dest");
        newExecutor = makeAddr("mtw-vector-new-executor");
        newSafe = makeAddr("mtw-vector-new-safe");
        successor = makeAddr("mtw-vector-successor");
    }

    function test_vectorsAreUpToDate() public {
        // Propuesta real de rotación (para el typed data de CancelRotation); deja la Safe en nonce 1.
        assertTrue(
            _exec(
                safe,
                executor,
                _call(
                    address(sys.rotationTimelock),
                    abi.encodeCall(IRotationTimelock.propose, (uint8(RotationKind.Executor), executor, newExecutor))
                ),
                _pair(userPk, executorPk)
            )
        );
        proposalId = sys.rotationTimelock.activeProposal(address(safe), RotationKind.Executor);
        _check("system.json", _systemJson());
        _check("safe-tx.json", _safeTxJson());
        _check("create2.json", _create2Json());
        _check("cancel-rotation.json", _cancelJson());
        _check("wire/eip712.json", _eip712Json());
    }

    function _check(string memory file, string memory json) internal {
        string memory path = string.concat(vm.projectRoot(), DIR, file);
        if (vm.envOr("EXPORT_VECTORS", false)) {
            vm.writeJson(json, path);
            return;
        }
        assertEq(
            keccak256(vm.parseJson(vm.readFile(path))),
            keccak256(vm.parseJson(json)),
            string.concat(file, " desactualizado: correr bash script/export-vectors.sh")
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Documentos

    function _systemJson() internal view returns (string memory) {
        string[] memory keys = new string[](3);
        keys[0] = _key("user", "mtw-user-key", userKey);
        keys[1] = _key("recovery", "mtw-recovery-key", recoveryKey);
        keys[2] = _key("executor", "mtw-executor-key", executor);
        string[] memory kv = new string[](6);
        kv[0] = _num("chainId", block.chainid);
        kv[1] = _num("forkBlock", ext.forkBlock);
        kv[2] = _str("keyDerivation", "privateKey = keccak256(utf8(label)) (forge-std makeAddrAndKey)");
        kv[3] = _raw("keys", _obj(keys));
        kv[4] = _raw("contracts", _contractsJson());
        kv[5] = _addr("safe", address(safe));
        return _obj(kv);
    }

    function _contractsJson() internal view returns (string memory) {
        string[] memory kv = new string[](10);
        kv[0] = _addr("securityGuard", address(sys.securityGuard));
        kv[1] = _addr("rotationTimelock", address(sys.rotationTimelock));
        kv[2] = _addr("walletFactory", address(sys.walletFactory));
        kv[3] = _addr("safeBootstrap", address(sys.safeBootstrap));
        kv[4] = _addr("policyRegistry", address(sys.policyRegistry));
        kv[5] = _addr("destinationWhitelist", address(sys.destinationWhitelist));
        kv[6] = _addr("denyAllModuleGuard", address(sys.denyAllModuleGuard));
        kv[7] = _addr("swapExecutor", address(sys.swapExecutor));
        kv[8] = _addr("usdc", ext.usdc);
        kv[9] = _addr("usdt", ext.usdt);
        return _obj(kv);
    }

    function _ops() internal view returns (Op[] memory ops) {
        address ex = address(sys.swapExecutor);
        address wl = address(sys.destinationWhitelist);
        address tl = address(sys.rotationTimelock);
        ops = new Op[](12);
        ops[0] = Op("NOOP", address(safe), "");
        ops[1] = Op("TRANSFER", ext.usdc, abi.encodeCall(IERC20.transfer, (dest, 1_000_000)));
        ops[2] = Op("APPROVE", ext.usdc, abi.encodeCall(IERC20.approve, (ex, 1_000_000)));
        ops[3] = Op("APPROVE_REVOKE", ext.usdc, abi.encodeCall(IERC20.approve, (ex, 0)));
        ops[4] = Op("SWAP", ex, abi.encodeCall(SwapExecutorV3.swap, (ext.usdc, 1_000_000, 995_000, DEADLINE)));
        ops[5] = Op("WHITELIST_ADD", wl, abi.encodeCall(IDestinationWhitelist.addDestination, (dest)));
        ops[6] = Op("WHITELIST_REMOVE", wl, abi.encodeCall(IDestinationWhitelist.removeDestination, (dest)));
        ops[7] = Op(
            "ROTATION_PROPOSE",
            tl,
            abi.encodeCall(IRotationTimelock.propose, (uint8(RotationKind.Executor), executor, newExecutor))
        );
        ops[8] = Op("ROTATION_CANCEL", tl, abi.encodeCall(IRotationTimelock.cancel, (proposalId)));
        ops[9] = Op(
            "ROTATION_EXECUTE",
            address(safe),
            abi.encodeCall(ISafe.swapOwner, (safe.prevOwner(executor), executor, newExecutor))
        );
        ops[10] = Op("MIGRATION_TRANSFER", ext.usdc, abi.encodeCall(IERC20.transfer, (newSafe, 5_000_000)));
        ops[11] = Op("GUARD_UPGRADE", address(safe), abi.encodeCall(ISafe.setGuard, (successor)));
    }

    function _safeTxJson() internal view returns (string memory) {
        Op[] memory ops = _ops();
        uint256 nonce = safe.nonce();
        string[] memory items = new string[](ops.length);
        for (uint256 i; i < ops.length; ++i) {
            items[i] = _safeTxItem(ops[i], nonce);
        }
        string[] memory kv = new string[](6);
        kv[0] = _addr("safe", address(safe));
        kv[1] = _num("chainId", block.chainid);
        kv[2] = _b32("domainTypehash", keccak256("EIP712Domain(uint256 chainId,address verifyingContract)"));
        kv[3] = _b32(
            "safeTxTypehash",
            keccak256(
                "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"
            )
        );
        kv[4] = _b32("domainSeparator", safe.domainSeparator());
        kv[5] = _raw("operations", _array(items));
        return _obj(kv);
    }

    function _safeTxItem(Op memory op, uint256 nonce) internal view returns (string memory) {
        bytes32 h =
            safe.getTransactionHash(op.to, 0, op.data, Operation.Call, 0, 0, 0, address(0), payable(address(0)), nonce);
        string[] memory kv = new string[](16);
        kv[0] = _str("opType", op.name);
        kv[1] = _addr("to", op.to);
        kv[2] = _str("value", "0");
        kv[3] = _str("data", vm.toString(op.data));
        kv[4] = _num("operation", 0);
        kv[5] = _str("safeTxGas", "0");
        kv[6] = _str("baseGas", "0");
        kv[7] = _str("gasPrice", "0");
        kv[8] = _addr("gasToken", address(0));
        kv[9] = _addr("refundReceiver", address(0));
        kv[10] = _num("nonce", nonce);
        kv[11] = _b32("safeTxHash", h);
        // Firmas ECDSA de U y de S (`r ‖ s ‖ v`) y el blob ordenado por dirección que exige Safe.
        kv[12] = _str("signatureUser", vm.toString(_ecdsa(userPk, h)));
        kv[13] = _str("signatureExecutor", vm.toString(_ecdsa(executorPk, h)));
        kv[14] = _str("signaturesUserExecutor", vm.toString(_sigs(h, _pair(userPk, executorPk))));
        kv[15] = _str("signatureRecovery", vm.toString(_ecdsa(recoveryPk, h)));
        return _obj(kv);
    }

    function _create2Json() internal returns (string memory) {
        string[] memory items = new string[](3);
        for (uint256 i; i < 3; ++i) {
            items[i] = _create2Item(i);
        }
        string[] memory kv = new string[](7);
        kv[0] = _addr("safeProxyFactory", ext.safeProxyFactory);
        kv[1] = _addr("safeSingleton", ext.safeL2Singleton);
        kv[2] = _b32("proxyCreationCodeHash", keccak256(ISafeProxyFactory(ext.safeProxyFactory).proxyCreationCode()));
        kv[3] = _b32("initCodeHash", sys.walletFactory.PROXY_INIT_CODE_HASH());
        kv[4] = _addr("safeBootstrap", address(sys.safeBootstrap));
        kv[5] = _str(
            "rule",
            "address = keccak256(0xff ++ safeProxyFactory ++ keccak256(keccak256(initializer) ++ saltNonce) ++ initCodeHash)[12:]"
        );
        kv[6] = _raw("predictions", _array(items));
        return _obj(kv);
    }

    function _create2Item(uint256 i) internal returns (string memory) {
        (address u,) = makeAddrAndKey(string.concat("mtw-vector-user-", vm.toString(i)));
        (address r,) = makeAddrAndKey(string.concat("mtw-vector-recovery-", vm.toString(i)));
        (address s,) = makeAddrAndKey(string.concat("mtw-vector-executor-", vm.toString(i)));
        uint256 saltNonce = i * 1000;
        bytes memory init = sys.walletFactory.initializerFor(u, r, s);
        string[] memory kv = new string[](7);
        kv[0] = _addr("userKey", u);
        kv[1] = _addr("recoveryKey", r);
        kv[2] = _addr("executor", s);
        kv[3] = _str("saltNonce", vm.toString(saltNonce));
        kv[4] = _str("initializer", vm.toString(init));
        kv[5] = _b32("salt", keccak256(abi.encodePacked(keccak256(init), saltNonce)));
        kv[6] = _addr("predictedSafe", sys.walletFactory.predictWalletAddress(u, r, s, saltNonce));
        return _obj(kv);
    }

    function _cancelJson() internal view returns (string memory) {
        IRotationTimelock.Proposal memory p = sys.rotationTimelock.getProposal(proposalId);
        bytes32 digest = sys.rotationTimelock.cancelDigest(proposalId);
        string[] memory domain = new string[](4);
        domain[0] = _str("name", "MTW RotationTimelock");
        domain[1] = _str("version", "1");
        domain[2] = _num("chainId", block.chainid);
        domain[3] = _addr("verifyingContract", address(sys.rotationTimelock));
        string[] memory message = new string[](2);
        message[0] = _b32("proposalId", proposalId);
        message[1] = _addr("safe", p.safe);
        string[] memory proposal = new string[](5);
        proposal[0] = _num("kind", uint8(p.kind));
        proposal[1] = _addr("oldValue", p.oldValue);
        proposal[2] = _addr("newValue", p.newValue);
        proposal[3] = _num("createdAt", p.createdAt);
        proposal[4] = _num("executableAt", p.executableAt);
        string[] memory kv = new string[](7);
        kv[0] = _raw("domain", _obj(domain));
        kv[1] = _str("primaryType", "CancelRotation(bytes32 proposalId,address safe)");
        kv[2] = _raw("message", _obj(message));
        kv[3] = _raw("proposal", _obj(proposal));
        kv[4] = _b32("digest", digest);
        kv[5] = _str("signatureUser", vm.toString(_ecdsa(userPk, digest)));
        kv[6] = _str("signatureRecovery", vm.toString(_ecdsa(recoveryPk, digest)));
        return _obj(kv);
    }

    // ---------------------------------------------------------------------------------------------
    // [W-01] Tipos EIP-712 de plataforma (dominio "MTW Wallet" con la WalletFactory como verifyingContract)

    bytes32 internal constant ENROLLMENT_NONCE = keccak256("mtw-vector-enrollment-nonce");
    bytes32 internal constant ACCEPTANCE_NONCE = keccak256("mtw-vector-acceptance-nonce");
    bytes32 internal constant RESTORE_NONCE = keccak256("mtw-vector-restore-nonce");
    string internal constant USER_ID = "4f1c2d9e-6b7a-4c3d-9e8f-0a1b2c3d4e5f";
    string internal constant WALLET_ID = "7d2e3f40-1a2b-4c5d-8e9f-a0b1c2d3e4f5";
    string internal constant ENROLLMENT_ID = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
    string internal constant PLATFORM_ID = "mtw";

    function _platformDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("MTW Wallet"),
                keccak256("1"),
                block.chainid,
                address(sys.walletFactory)
            )
        );
    }

    function _typed(string memory primaryType, string memory typeString, bytes memory encodedFields, uint256 pk)
        internal
        view
        returns (string memory)
    {
        bytes32 typehash = keccak256(bytes(typeString));
        bytes32 structHash = keccak256(abi.encodePacked(typehash, encodedFields));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _platformDomainSeparator(), structHash));
        string[] memory kv = new string[](7);
        kv[0] = _str("primaryType", primaryType);
        kv[1] = _str("type", typeString);
        kv[2] = _b32("typehash", typehash);
        kv[3] = _b32("structHash", structHash);
        kv[4] = _b32("digest", digest);
        kv[5] = _addr("signer", vm.addr(pk));
        kv[6] = _str("signature", vm.toString(_ecdsa(pk, digest)));
        return _obj(kv);
    }

    function _eip712Json() internal returns (string memory) {
        (address newKey, uint256 newKeyPk) = makeAddrAndKey("mtw-vector-new-user-key");
        address expectedSafe = sys.walletFactory.predictWalletAddress(userKey, recoveryKey, executor, 0);
        string[] memory items = new string[](4);
        items[0] = _withMessage(
            _typed(
                "WalletCreationAuthorization",
                "WalletCreationAuthorization(string userId,string platformId,string walletId,address userKey,address recoveryKey,address executor,uint256 saltNonce,address expectedSafe,bytes32 enrollmentNonce)",
                abi.encode(
                    keccak256(bytes(USER_ID)),
                    keccak256(bytes(PLATFORM_ID)),
                    keccak256(bytes(WALLET_ID)),
                    userKey,
                    recoveryKey,
                    executor,
                    uint256(0),
                    expectedSafe,
                    ENROLLMENT_NONCE
                ),
                userPk
            ),
            _creationMessage(expectedSafe)
        );
        items[1] = _withMessage(
            _typed(
                "RecoveryProofOfControl",
                "RecoveryProofOfControl(string userId,string platformId,string enrollmentId,address recoveryKey)",
                abi.encode(
                    keccak256(bytes(USER_ID)),
                    keccak256(bytes(PLATFORM_ID)),
                    keccak256(bytes(ENROLLMENT_ID)),
                    recoveryKey
                ),
                recoveryPk
            ),
            string.concat(
                '{"userId":"',
                USER_ID,
                '","platformId":"',
                PLATFORM_ID,
                '","enrollmentId":"',
                ENROLLMENT_ID,
                '","recoveryKey":"',
                vm.toString(recoveryKey),
                '"}'
            )
        );
        items[2] = _withMessage(
            _typed(
                "KeyAcceptance",
                "KeyAcceptance(string walletId,uint8 role,address newKey,bytes32 nonce)",
                abi.encode(keccak256(bytes(WALLET_ID)), uint8(1), newKey, ACCEPTANCE_NONCE),
                newKeyPk
            ),
            string.concat(
                '{"walletId":"',
                WALLET_ID,
                '","role":1,"newKey":"',
                vm.toString(newKey),
                '","nonce":"',
                vm.toString(ACCEPTANCE_NONCE),
                '"}'
            )
        );
        items[3] = _withMessage(
            _typed(
                "KeyRestore",
                "KeyRestore(string userId,string walletId,address keyAddress,bytes32 nonce)",
                abi.encode(keccak256(bytes(USER_ID)), keccak256(bytes(WALLET_ID)), userKey, RESTORE_NONCE),
                userPk
            ),
            string.concat(
                '{"userId":"',
                USER_ID,
                '","walletId":"',
                WALLET_ID,
                '","keyAddress":"',
                vm.toString(userKey),
                '","nonce":"',
                vm.toString(RESTORE_NONCE),
                '"}'
            )
        );
        string[] memory domain = new string[](4);
        domain[0] = _str("name", "MTW Wallet");
        domain[1] = _str("version", "1");
        domain[2] = _num("chainId", block.chainid);
        domain[3] = _addr("verifyingContract", address(sys.walletFactory));
        string[] memory kv = new string[](5);
        kv[0] = _raw("domain", _obj(domain));
        kv[1] = _b32("domainSeparator", _platformDomainSeparator());
        kv[2] = _str("roleEncoding", "uint8: 1 = U, 2 = R, 3 = S (enum Role de los contratos)");
        kv[3] = _str("cancelRotation", "ver cancel-rotation.json (dominio MTW RotationTimelock)");
        kv[4] = _raw("types", _array(items));
        return _obj(kv);
    }

    function _creationMessage(address expectedSafe) internal view returns (string memory) {
        string[] memory kv = new string[](9);
        kv[0] = _str("userId", USER_ID);
        kv[1] = _str("platformId", PLATFORM_ID);
        kv[2] = _str("walletId", WALLET_ID);
        kv[3] = _addr("userKey", userKey);
        kv[4] = _addr("recoveryKey", recoveryKey);
        kv[5] = _addr("executor", executor);
        kv[6] = _str("saltNonce", "0");
        kv[7] = _addr("expectedSafe", expectedSafe);
        kv[8] = _b32("enrollmentNonce", ENROLLMENT_NONCE);
        return _obj(kv);
    }

    /// @dev Agrega `message` (los valores tipados) al objeto de un tipo.
    function _withMessage(string memory typedJson, string memory message) internal pure returns (string memory) {
        bytes memory b = bytes(typedJson);
        bytes memory head = new bytes(b.length - 1);
        for (uint256 i; i < head.length; ++i) {
            head[i] = b[i];
        }
        return string.concat(string(head), ',"message":', message, "}");
    }

    // ---------------------------------------------------------------------------------------------
    // JSON

    function _obj(string[] memory kv) internal pure returns (string memory out) {
        out = "{";
        for (uint256 i; i < kv.length; ++i) {
            out = string.concat(out, i == 0 ? "" : ",", kv[i]);
        }
        out = string.concat(out, "}");
    }

    function _array(string[] memory items) internal pure returns (string memory out) {
        out = "[";
        for (uint256 i; i < items.length; ++i) {
            out = string.concat(out, i == 0 ? "" : ",", items[i]);
        }
        out = string.concat(out, "]");
    }

    function _key(string memory role, string memory label, address a) internal pure returns (string memory) {
        string[] memory kv = new string[](2);
        kv[0] = _str("label", label);
        kv[1] = _addr("address", a);
        return _raw(role, _obj(kv));
    }

    function _str(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('"', k, '":"', v, '"');
    }

    function _num(string memory k, uint256 v) internal pure returns (string memory) {
        return string.concat('"', k, '":', vm.toString(v));
    }

    function _addr(string memory k, address v) internal pure returns (string memory) {
        return _str(k, vm.toString(v));
    }

    function _b32(string memory k, bytes32 v) internal pure returns (string memory) {
        return _str(k, vm.toString(v));
    }

    function _raw(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('"', k, '":', v);
    }
}
