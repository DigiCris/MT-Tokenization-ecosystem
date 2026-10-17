// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";
import {ChainConfig} from "./ChainConfig.sol";
import {SystemDeployer} from "./SystemDeployer.sol";
import {PolicyRegistry} from "../../src/PolicyRegistry.sol";

/// @title DeploymentJson
/// @notice Formato de `deployments/<red>.json` ([C-SCR-01]) compartido por `DeployCore` y `VerifyDeployment`.
/// @dev Redes de esta etapa (todas sobre Anvil): `local` (fork del compose) y `ci` (Anvil efímero del job de
///      contratos), ambos gitignored y con cuentas de `LOCAL_SEED`; `fork/staging` y `fork/production` (ensayos).
///      Los `base-mainnet*.json` los escribe `DeployBase` en el despliegue final ([C-SCR-04]).
library DeploymentJson {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Versión del formato del JSON.
    uint256 internal constant SCHEMA_VERSION = 1;

    /// @notice Compilador y settings con los que se construyó el bytecode desplegado (metadata del artefacto).
    struct Compiler {
        string solc;
        string evmVersion;
        bool optimizer;
        uint256 optimizerRuns;
        bool viaIR;
        string bytecodeHash;
        bool appendCBOR;
    }

    /// @notice Datos del deploy que no salen de los contratos.
    struct Header {
        string network;
        address deployer;
        uint64 deployerNonce;
        string commit;
        bool dirty;
    }

    /// @notice `DEPLOY_NETWORK` no es una red de deploy sobre el fork.
    error UnknownNetwork(string network);

    /// @notice Red de `DEPLOY_NETWORK` (por defecto `local`).
    function network() internal view returns (string memory n) {
        n = VM.envOr("DEPLOY_NETWORK", string("local"));
        if (!isSeedNetwork(n) && !eq(n, "fork/staging") && !eq(n, "fork/production")) revert UnknownNetwork(n);
    }

    /// @notice true para las redes con cuentas derivadas de `LOCAL_SEED` (`local`, `ci`).
    function isSeedNetwork(string memory n) internal pure returns (bool) {
        return eq(n, "local") || eq(n, "ci");
    }

    /// @notice Ruta absoluta de `deployments/<red>.json`.
    function path(string memory n) internal view returns (string memory) {
        return string.concat(VM.projectRoot(), "/deployments/", n, ".json");
    }

    /// @notice JSON completo del deployment `d` (addresses, codehash, constructor args, compilador, commit,
    ///         timestamp, chainId, deployer y policy inicial).
    function build(
        ChainConfig.External memory ext,
        Header memory h,
        SystemDeployer.Params memory p,
        SystemDeployer.Deployment memory d
    ) internal returns (string memory) {
        string memory root = "deployment";
        VM.serializeUint(root, "schemaVersion", SCHEMA_VERSION);
        VM.serializeString(root, "network", h.network);
        VM.serializeUint(root, "chainId", block.chainid);
        VM.serializeUint(root, "forkBlock", ext.forkBlock);
        VM.serializeUint(root, "block", block.number);
        VM.serializeUint(root, "timestamp", block.timestamp);
        VM.serializeAddress(root, "deployer", h.deployer);
        VM.serializeUint(root, "deployerNonce", h.deployerNonce);
        VM.serializeString(root, "git", string.concat('{"commit":"', h.commit, '","dirty":', VM.toString(h.dirty), "}"));
        VM.serializeString(root, "compiler", compilerJson(compiler("SecurityGuard")));
        VM.serializeString(root, "policy", policyJson(p));
        return VM.serializeString(root, "contracts", contractsJson(ext, p, d));
    }

    /// @notice Objeto JSON de la policy inicial.
    function policyJson(SystemDeployer.Params memory p) internal pure returns (string memory) {
        return string.concat(
            '{"admin":"',
            VM.toString(p.admin),
            '","mode":"',
            p.mode == PolicyRegistry.Mode.Restricted ? "Restricted" : "Bootstrap",
            '","guardians":',
            addressArray(p.guardians),
            ',"v1Policy":',
            VM.toString(p.v1Policy),
            ',"predecessorGuard":"',
            VM.toString(p.predecessorGuard),
            '"}'
        );
    }

    /// @notice Objeto JSON con la entrada de cada contrato del sistema.
    function contractsJson(
        ChainConfig.External memory ext,
        SystemDeployer.Params memory p,
        SystemDeployer.Deployment memory d
    ) internal view returns (string memory) {
        SystemDeployer.ConstructorArgs memory a = SystemDeployer.constructorArgs(ext, p, d);
        string memory first = string.concat(
            '{"DenyAllModuleGuard":',
            contractEntry(address(d.denyAllModuleGuard), ""),
            ',"DestinationWhitelist":',
            contractEntry(address(d.destinationWhitelist), ""),
            ',"SwapExecutorV3":',
            contractEntry(address(d.swapExecutor), a.swapExecutor),
            ',"PolicyRegistry":',
            contractEntry(address(d.policyRegistry), a.policyRegistry)
        );
        return string.concat(
            first,
            ',"SecurityGuard":',
            contractEntry(address(d.securityGuard), a.securityGuard),
            ',"RotationTimelock":',
            contractEntry(address(d.rotationTimelock), a.rotationTimelock),
            ',"SafeBootstrap":',
            contractEntry(address(d.safeBootstrap), a.safeBootstrap),
            ',"WalletFactory":',
            contractEntry(address(d.walletFactory), a.walletFactory),
            "}"
        );
    }

    /// @notice Escribe el JSON de la red. Crea `deployments/` (o `deployments/fork/`) si no existe: git no versiona
    ///         directorios vacíos y un checkout limpio (CI) no lo trae.
    function write(string memory n, string memory json) internal {
        VM.createDir(string.concat(VM.projectRoot(), isSeedNetwork(n) ? "/deployments" : "/deployments/fork"), true);
        VM.writeJson(json, path(n));
    }

    /// @notice Artefacto de compilación (`out/<Nombre>.sol/<Nombre>.json`).
    function artifact(string memory contractName) internal view returns (string memory) {
        return VM.readFile(string.concat(VM.projectRoot(), "/out/", contractName, ".sol/", contractName, ".json"));
    }

    /// @notice Compilador y settings de la metadata del artefacto de `contractName`.
    function compiler(string memory contractName) internal view returns (Compiler memory c) {
        string memory json = artifact(contractName);
        c.solc = VM.parseJsonString(json, ".metadata.compiler.version");
        c.evmVersion = VM.parseJsonString(json, ".metadata.settings.evmVersion");
        c.optimizer = VM.parseJsonBool(json, ".metadata.settings.optimizer.enabled");
        c.optimizerRuns = VM.parseJsonUint(json, ".metadata.settings.optimizer.runs");
        c.viaIR =
            VM.keyExistsJson(json, ".metadata.settings.viaIR") && VM.parseJsonBool(json, ".metadata.settings.viaIR");
        c.bytecodeHash = VM.keyExistsJson(json, ".metadata.settings.metadata.bytecodeHash")
            ? VM.parseJsonString(json, ".metadata.settings.metadata.bytecodeHash")
            : "ipfs";
        c.appendCBOR = !VM.keyExistsJson(json, ".metadata.settings.metadata.appendCBOR")
            || VM.parseJsonBool(json, ".metadata.settings.metadata.appendCBOR");
    }

    /// @notice Compilador y settings registrados en un JSON de deployment.
    function readCompiler(string memory json) internal pure returns (Compiler memory c) {
        c.solc = VM.parseJsonString(json, ".compiler.solc");
        c.evmVersion = VM.parseJsonString(json, ".compiler.evmVersion");
        c.optimizer = VM.parseJsonBool(json, ".compiler.optimizer");
        c.optimizerRuns = VM.parseJsonUint(json, ".compiler.optimizerRuns");
        c.viaIR = VM.parseJsonBool(json, ".compiler.viaIR");
        c.bytecodeHash = VM.parseJsonString(json, ".compiler.bytecodeHash");
        c.appendCBOR = VM.parseJsonBool(json, ".compiler.appendCBOR");
    }

    /// @notice true si ambos registros de compilador son idénticos.
    function sameCompiler(Compiler memory a, Compiler memory b) internal pure returns (bool) {
        return eq(a.solc, b.solc) && eq(a.evmVersion, b.evmVersion) && a.optimizer == b.optimizer
            && a.optimizerRuns == b.optimizerRuns && a.viaIR == b.viaIR && eq(a.bytecodeHash, b.bytecodeHash)
            && a.appendCBOR == b.appendCBOR;
    }

    /// @notice Objeto JSON del compilador.
    function compilerJson(Compiler memory c) internal pure returns (string memory) {
        return string.concat(
            '{"solc":"',
            c.solc,
            '","evmVersion":"',
            c.evmVersion,
            '","optimizer":',
            VM.toString(c.optimizer),
            ',"optimizerRuns":',
            VM.toString(c.optimizerRuns),
            ',"viaIR":',
            VM.toString(c.viaIR),
            ',"bytecodeHash":"',
            c.bytecodeHash,
            '","appendCBOR":',
            VM.toString(c.appendCBOR),
            "}"
        );
    }

    /// @notice Entrada de un contrato: address, codehash de runtime, argumentos de constructor ABI-encoded y
    ///         `proxy: false` / `implementation: null` (ningún contrato del sistema usa proxy, [C-GEN]).
    function contractEntry(address a, bytes memory constructorArgs) internal view returns (string memory) {
        return string.concat(
            '{"address":"',
            VM.toString(a),
            '","codehash":"',
            VM.toString(a.codehash),
            '","constructorArgs":"',
            VM.toString(constructorArgs),
            '","proxy":false,"implementation":null}'
        );
    }

    /// @notice Arreglo JSON de direcciones.
    function addressArray(address[] memory values) internal pure returns (string memory out) {
        out = "[";
        for (uint256 i; i < values.length; ++i) {
            out = string.concat(out, i == 0 ? '"' : ',"', VM.toString(values[i]), '"');
        }
        out = string.concat(out, "]");
    }

    /// @notice Igualdad de strings.
    function eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
