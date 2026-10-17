// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Script, console} from "forge-std/Script.sol";
import {ChainConfig} from "./lib/ChainConfig.sol";
import {DeploymentJson} from "./lib/DeploymentJson.sol";
import {GovernanceSafe} from "./lib/GovernanceSafe.sol";
import {LocalKeys} from "./lib/LocalKeys.sol";
import {SystemDeployer} from "./lib/SystemDeployer.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";

/// @title DeployCore
/// @notice Deploy de los contratos del sistema en el orden de §6.1 sobre el fork ([C-SCR-01]) y escritura de
///         `deployments/<red>.json`. Entorno y uso en `docs/runbooks/deploy.md` (`scripts/deploy-core <red>`).
/// @dev La `WalletFactory` sale de `CREATE` del deployer con nonce inicial + 6 y el Guard la recibe predicha: el
///      nonce se verifica al inicio y la dirección real al final (si no coincide, el script revierte antes de
///      transmitir). Sólo redes sobre Anvil (`local`, `ci`, `fork/staging`, `fork/production`); Base mainnet queda para
///      `DeployBase` en el despliegue final ([C-SCR-04]).
contract DeployCore is Script {
    /// @notice Deploys del deployer anteriores a la `WalletFactory` (§6.1).
    uint64 internal constant FACTORY_NONCE_OFFSET = 6;
    /// @notice Saldo mínimo de las cuentas que transmiten (las fondea `FundForkAccounts`).
    uint256 internal constant MIN_SENDER_BALANCE = 0.1 ether;

    /// @notice El RPC no es un fork de Anvil.
    error NotAFork();
    /// @notice La cadena no es la de `config/chains/base-mainnet.json`.
    error UnexpectedChain(uint256 actual, uint256 expected);
    /// @notice El codehash on-chain de un contrato externo no es el verificado en P03.
    error ExternalContractMismatch(string key);
    /// @notice `DEPLOYER_KEY_SOURCE` no es válido para la red.
    error UnsupportedKeySource(string source);
    /// @notice Sin `local-seed`, forge necesita una wallet (`--keystore`, `--ledger`, `--trezor`) como sender.
    error MissingDeployer();
    /// @notice La cuenta no tiene saldo para transmitir: correr antes `FundForkAccounts` (lo hace `deploy-core`).
    error SenderNotFunded(address account);
    /// @notice El nonce del deployer no es el esperado (las direcciones predichas no valdrían).
    error DeployerNonceMismatch(uint64 actual, uint64 expected);
    /// @notice La dirección predicha de la `WalletFactory` ya tiene código.
    error FactoryAddressOccupied(address predicted);
    /// @notice `GOVERNANCE_SAFE_ADDRESS` es obligatoria fuera de `local`.
    error MissingAdmin();
    /// @notice El admin no es una Safe multisig utilizable ([GovernanceSafe.check]).
    error InvalidAdmin(address admin, bytes32 reason);
    /// @notice `POLICY_GUARDIANS` es obligatoria fuera de `local`.
    error MissingGuardians();
    /// @notice `POLICY_MODE` no es `restricted` (o `bootstrap`, sólo en `local`).
    error InvalidPolicyMode(string mode);
    /// @notice `DEPLOY_GIT_COMMIT` no es un hash de commit de 40 caracteres hex.
    error InvalidCommit();
    /// @notice Fuera de `local` el deploy exige un árbol de trabajo limpio (`DEPLOY_GIT_DIRTY=false`).
    error DirtyWorkingTree();
    /// @notice La Governance Safe local no quedó en la dirección predicha.
    error GovernanceSafeMismatch(address predicted, address actual);
    /// @notice La `WalletFactory` desplegada no valida su propia configuración.
    error PostDeployCheckFailed(bytes32 reason);

    struct Inputs {
        string network;
        bool local;
        bool seedKey;
        address admin;
        PolicyRegistry.Mode mode;
        address[] guardians;
        address predecessorGuard;
        string commit;
        bool dirty;
    }

    /// @notice Deployer, nonce inicial y dirección predicha de la `WalletFactory`.
    struct Plan {
        uint256 deployerKey;
        address deployer;
        uint64 nonce;
        address predictedFactory;
    }

    /// @notice Despliega el sistema y escribe `deployments/<red>.json`.
    function run() public virtual returns (SystemDeployer.Deployment memory d) {
        ChainConfig.External memory ext = ChainConfig.load();
        _checkChain(ext);
        Inputs memory inp = _inputs();
        Plan memory plan = _plan(ext, inp);
        SystemDeployer.Params memory p = SystemDeployer.Params({
            admin: inp.admin,
            mode: inp.mode,
            guardians: inp.guardians,
            v1Policy: true,
            predecessorGuard: inp.predecessorGuard
        });
        if (inp.seedKey) vm.startBroadcast(plan.deployerKey);
        else vm.startBroadcast(plan.deployer);
        d = SystemDeployer.deploy(ext, p, plan.predictedFactory);
        vm.stopBroadcast();

        bytes32 reason = d.walletFactory.validateConfig(SystemDeployer.factoryConfig(ext, d));
        if (reason != bytes32(0)) revert PostDeployCheckFailed(reason);

        DeploymentJson.write(
            inp.network,
            DeploymentJson.build(
                ext, DeploymentJson.Header(inp.network, plan.deployer, plan.nonce, inp.commit, inp.dirty), p, d
            )
        );
        console.log("red:", inp.network);
        console.log("deployer:", plan.deployer, "nonce inicial:", plan.nonce);
        console.log("governance safe (admin):", inp.admin);
        console.log("SecurityGuard:", address(d.securityGuard));
        console.log("WalletFactory (predicha y verificada):", address(d.walletFactory));
        console.log("JSON:", DeploymentJson.path(inp.network));
    }

    /// @dev Resuelve deployer y admin, verifica el nonce del deployer y predice la `WalletFactory` (§6.1).
    function _plan(ChainConfig.External memory ext, Inputs memory inp) private returns (Plan memory plan) {
        (plan.deployerKey, plan.deployer) = _deployer(inp);
        if (inp.admin == address(0)) inp.admin = _localGovernanceSafe(ext);
        bytes32 adminReason = GovernanceSafe.check(ext, inp.admin);
        if (adminReason != bytes32(0)) revert InvalidAdmin(inp.admin, adminReason);

        plan.nonce = vm.getNonce(plan.deployer);
        uint256 expectedNonce = vm.envOr("EXPECTED_DEPLOYER_NONCE", inp.local ? uint256(plan.nonce) : 0);
        if (plan.nonce != expectedNonce) revert DeployerNonceMismatch(plan.nonce, uint64(expectedNonce));
        plan.predictedFactory = vm.computeCreateAddress(plan.deployer, plan.nonce + FACTORY_NONCE_OFFSET);
        if (plan.predictedFactory.code.length != 0) revert FactoryAddressOccupied(plan.predictedFactory);
    }

    function _checkChain(ChainConfig.External memory ext) private {
        if (!LocalKeys.isAnvil()) revert NotAFork();
        if (block.chainid != ext.chainId) revert UnexpectedChain(block.chainid, ext.chainId);
        string[] memory keys = ChainConfig.contractKeys();
        for (uint256 i; i < keys.length; ++i) {
            (address a, bytes32 codehash) = ChainConfig.contractAt(keys[i]);
            if (a.codehash != codehash) revert ExternalContractMismatch(keys[i]);
        }
    }

    function _inputs() private returns (Inputs memory inp) {
        inp.network = DeploymentJson.network();
        inp.local = DeploymentJson.isSeedNetwork(inp.network);
        string memory source = vm.envOr("DEPLOYER_KEY_SOURCE", string("local-seed"));
        if (DeploymentJson.eq(source, "local-seed")) {
            if (!inp.local) revert UnsupportedKeySource(source);
            inp.seedKey = true;
        } else if (
            !DeploymentJson.eq(source, "keystore") && !DeploymentJson.eq(source, "ledger")
                && !DeploymentJson.eq(source, "trezor")
        ) {
            revert UnsupportedKeySource(source);
        }
        inp.admin = _optionalAddress("GOVERNANCE_SAFE_ADDRESS");
        if (inp.admin == address(0) && !inp.local) revert MissingAdmin();
        inp.guardians = _optionalAddresses("POLICY_GUARDIANS");
        if (inp.guardians.length == 0) {
            if (!inp.local) revert MissingGuardians();
            inp.guardians = new address[](2);
            inp.guardians[0] = LocalKeys.addr("guardian-1");
            inp.guardians[1] = LocalKeys.addr("guardian-2");
        }
        inp.mode = _mode(inp.local);
        inp.predecessorGuard = _optionalAddress("PREDECESSOR_GUARD");
        inp.commit = vm.envOr("DEPLOY_GIT_COMMIT", string(""));
        if (!_isCommitHash(inp.commit)) revert InvalidCommit();
        inp.dirty = vm.envOr("DEPLOY_GIT_DIRTY", true);
        if (inp.dirty && !inp.local) revert DirtyWorkingTree();
    }

    /// @dev `local-seed`: clave derivada de `LOCAL_SEED`. Si no, la wallet que forge recibió por CLI (sender).
    function _deployer(Inputs memory inp) private returns (uint256 key, address deployer) {
        if (inp.seedKey) {
            key = LocalKeys.key("deployer");
            deployer = vm.addr(key);
        } else {
            deployer = msg.sender;
            if (deployer == DEFAULT_SENDER) revert MissingDeployer();
        }
        if (deployer.balance < MIN_SENDER_BALANCE) revert SenderNotFunded(deployer);
    }

    /// @dev Governance Safe 2-de-3 local con owners derivados de `LOCAL_SEED`; la crea el owner 1 si no existe.
    function _localGovernanceSafe(ChainConfig.External memory ext) private returns (address safe) {
        address[] memory owners = new address[](3);
        owners[0] = LocalKeys.addr("governance-owner-1");
        owners[1] = LocalKeys.addr("governance-owner-2");
        owners[2] = LocalKeys.addr("governance-owner-3");
        safe = GovernanceSafe.predict(ext, owners, GovernanceSafe.LOCAL_THRESHOLD, GovernanceSafe.LOCAL_SALT_NONCE);
        if (safe.code.length != 0) return safe;
        uint256 creatorKey = LocalKeys.key("governance-owner-1");
        if (vm.addr(creatorKey).balance < MIN_SENDER_BALANCE) revert SenderNotFunded(vm.addr(creatorKey));
        vm.startBroadcast(creatorKey);
        address created =
            GovernanceSafe.create(ext, owners, GovernanceSafe.LOCAL_THRESHOLD, GovernanceSafe.LOCAL_SALT_NONCE);
        vm.stopBroadcast();
        if (created != safe) revert GovernanceSafeMismatch(safe, created);
    }

    function _mode(bool local) private view returns (PolicyRegistry.Mode) {
        string memory m = vm.envOr("POLICY_MODE", string("restricted"));
        if (DeploymentJson.eq(m, "restricted")) return PolicyRegistry.Mode.Restricted;
        if (DeploymentJson.eq(m, "bootstrap") && local) return PolicyRegistry.Mode.Bootstrap;
        revert InvalidPolicyMode(m);
    }

    function _optionalAddress(string memory name) private view returns (address) {
        string memory raw = vm.envOr(name, string(""));
        return bytes(raw).length == 0 ? address(0) : vm.parseAddress(raw);
    }

    function _optionalAddresses(string memory name) private view returns (address[] memory) {
        string memory raw = vm.envOr(name, string(""));
        return bytes(raw).length == 0 ? new address[](0) : vm.envAddress(name, ",");
    }

    function _isCommitHash(string memory value) private pure returns (bool) {
        bytes memory b = bytes(value);
        if (b.length != 40) return false;
        for (uint256 i; i < 40; ++i) {
            bytes1 c = b[i];
            if (!((c >= "0" && c <= "9") || (c >= "a" && c <= "f"))) return false;
        }
        return true;
    }
}
