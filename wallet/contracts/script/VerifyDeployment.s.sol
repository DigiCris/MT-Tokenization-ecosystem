// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Script, console} from "forge-std/Script.sol";
import {BytecodeCheck} from "./lib/BytecodeCheck.sol";
import {ChainConfig} from "./lib/ChainConfig.sol";
import {DeploymentJson} from "./lib/DeploymentJson.sol";
import {GovernanceSafe} from "./lib/GovernanceSafe.sol";
import {SystemDeployer} from "./lib/SystemDeployer.sol";
import {DenyAllModuleGuard} from "../src/DenyAllModuleGuard.sol";
import {DestinationWhitelist} from "../src/DestinationWhitelist.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {RotationTimelock} from "../src/RotationTimelock.sol";
import {SafeBootstrap} from "../src/SafeBootstrap.sol";
import {SecurityGuard} from "../src/SecurityGuard.sol";
import {SwapExecutorV3} from "../src/SwapExecutorV3.sol";
import {WalletFactory} from "../src/WalletFactory.sol";
import {ISafeProxyFactory} from "../src/interfaces/ISafe.sol";
import {OpType} from "../src/libraries/OpTypes.sol";
import {Role} from "../src/libraries/Roles.sol";

/// @title VerifyDeployment
/// @notice Re-lee on-chain todo el deployment de `deployments/<red>.json` y lo compara contra el JSON y contra
///         `config/chains/base-mainnet.json` ([C-SCR-02]): contratos externos, direcciones `CREATE` del deployer,
///         codehash, runtime idéntico al artefacto de las fuentes actuales (salvo inmutables), compilador, cada
///         inmutable y cableado, estado inicial de la policy y argumentos de constructor. Sin transacciones.
/// @dev Uso: `DEPLOY_NETWORK=<red> forge script script/VerifyDeployment.s.sol --rpc-url $LOCAL_RPC_URL`. Reporta
///      cada diferencia y revierte al final si hubo alguna.
contract VerifyDeployment is Script {
    uint256 private _checks;
    uint256 private _failures;

    /// @notice Hubo `failures` verificaciones fallidas (detalle en el log).
    error VerificationFailed(uint256 failures);

    /// @notice Verifica el deployment de `DEPLOY_NETWORK` (`deployments/<red>.json`).
    function run() external {
        string memory network = DeploymentJson.network();
        string memory json = vm.readFile(DeploymentJson.path(network));
        verify(json);
        _expect(DeploymentJson.eq(vm.parseJsonString(json, ".network"), network), "red del JSON == DEPLOY_NETWORK");
        uint256 failures = _failures;
        if (failures != 0) {
            console.log("VerifyDeployment FALLA:", failures, "de", _checks);
            revert VerificationFailed(failures);
        }
        console.log("VerifyDeployment OK:", network);
        console.log("verificaciones:", _checks);
        console.log("commit del deployment:", vm.parseJsonString(json, ".git.commit"));
    }

    /// @notice Compara el deployment descripto por `json` con la cadena; devuelve la cantidad de diferencias.
    function verify(string memory json) public returns (uint256 failures) {
        _checks = 0;
        _failures = 0;
        ChainConfig.External memory ext = ChainConfig.load();
        _expect(block.chainid == ext.chainId, "chainId del RPC == config");
        _expect(vm.parseJsonUint(json, ".chainId") == ext.chainId, "chainId del JSON == config");
        _expect(vm.parseJsonUint(json, ".schemaVersion") == DeploymentJson.SCHEMA_VERSION, "schemaVersion");
        _expect(vm.parseJsonUint(json, ".forkBlock") == ext.forkBlock, "bloque de fork del JSON == config");
        _checkExternal(ext);

        SystemDeployer.Deployment memory d = _deployment(json);
        SystemDeployer.Params memory p = _params(json);
        _checkAddresses(json, d);
        _checkCode(json, d);
        _checkConstructorArgs(json, ext, p, d);
        // Sin código en alguna dirección, los getters revertirían: la falla ya quedó contada en `_checkCode`.
        if (_allHaveCode(d)) {
            _checkWiring(ext, p, d);
            _checkPolicy(ext, p, d);
        } else {
            _expect(false, "contratos del sistema sin codigo: se omiten inmutables, cableado y policy");
        }
        return _failures;
    }

    function _allHaveCode(SystemDeployer.Deployment memory d) private view returns (bool) {
        return address(d.denyAllModuleGuard).code.length != 0 && address(d.destinationWhitelist).code.length != 0
            && address(d.swapExecutor).code.length != 0 && address(d.policyRegistry).code.length != 0
            && address(d.securityGuard).code.length != 0 && address(d.rotationTimelock).code.length != 0
            && address(d.safeBootstrap).code.length != 0 && address(d.walletFactory).code.length != 0;
    }

    /// @notice Cantidad de verificaciones de la última corrida.
    function checks() external view returns (uint256) {
        return _checks;
    }

    // ---------------------------------------------------------------------------------------------
    // Contratos externos

    function _checkExternal(ChainConfig.External memory ext) private {
        string memory cfg = vm.readFile(string.concat(vm.projectRoot(), ChainConfig.PATH));
        string[] memory keys = ChainConfig.contractKeys();
        for (uint256 i; i < keys.length; ++i) {
            (address a, bytes32 codehash) = ChainConfig.contractAt(keys[i]);
            _expect(a.codehash == codehash, string.concat("codehash externo: ", keys[i]));
            string memory impl = string.concat(".contracts.", keys[i], ".implementation");
            if (vm.keyExistsJson(cfg, impl)) {
                address implAddr = vm.parseJsonAddress(cfg, string.concat(impl, ".address"));
                bytes32 slot = vm.parseJsonBytes32(cfg, string.concat(impl, ".slot"));
                _expect(
                    address(uint160(uint256(vm.load(a, slot)))) == implAddr,
                    string.concat("implementacion del proxy externo: ", keys[i])
                );
                _expect(
                    implAddr.codehash == vm.parseJsonBytes32(cfg, string.concat(impl, ".codehash")),
                    string.concat("codehash de la implementacion externa: ", keys[i])
                );
            }
        }
        _expect(ext.safeL2Singleton != address(0) && ext.safeProxyFactory != address(0), "config externa completa");
    }

    // ---------------------------------------------------------------------------------------------
    // Lectura del JSON

    function _deployment(string memory json) private pure returns (SystemDeployer.Deployment memory d) {
        d.denyAllModuleGuard = DenyAllModuleGuard(_addr(json, "DenyAllModuleGuard"));
        d.destinationWhitelist = DestinationWhitelist(_addr(json, "DestinationWhitelist"));
        d.swapExecutor = SwapExecutorV3(_addr(json, "SwapExecutorV3"));
        d.policyRegistry = PolicyRegistry(_addr(json, "PolicyRegistry"));
        d.securityGuard = SecurityGuard(_addr(json, "SecurityGuard"));
        d.rotationTimelock = RotationTimelock(_addr(json, "RotationTimelock"));
        d.safeBootstrap = SafeBootstrap(_addr(json, "SafeBootstrap"));
        d.walletFactory = WalletFactory(_addr(json, "WalletFactory"));
    }

    function _params(string memory json) private pure returns (SystemDeployer.Params memory p) {
        p.admin = vm.parseJsonAddress(json, ".policy.admin");
        p.mode = DeploymentJson.eq(vm.parseJsonString(json, ".policy.mode"), "Restricted")
            ? PolicyRegistry.Mode.Restricted
            : PolicyRegistry.Mode.Bootstrap;
        p.guardians = vm.parseJsonAddressArray(json, ".policy.guardians");
        p.v1Policy = vm.parseJsonBool(json, ".policy.v1Policy");
        p.predecessorGuard = vm.parseJsonAddress(json, ".policy.predecessorGuard");
    }

    function _addr(string memory json, string memory name) private pure returns (address) {
        return vm.parseJsonAddress(json, string.concat(".contracts.", name, ".address"));
    }

    // ---------------------------------------------------------------------------------------------
    // Direcciones, código y compilador

    /// @dev Orden de §6.1: cada contrato es el `CREATE` del deployer con el nonce inicial + su posición; el
    ///      `RotationTimelock` es el primer `CREATE` del Guard (nonce 1).
    function _checkAddresses(string memory json, SystemDeployer.Deployment memory d) private {
        address deployer = vm.parseJsonAddress(json, ".deployer");
        uint256 n = vm.parseJsonUint(json, ".deployerNonce");
        _expect(address(d.denyAllModuleGuard) == vm.computeCreateAddress(deployer, n), "CREATE DenyAllModuleGuard");
        _expect(
            address(d.destinationWhitelist) == vm.computeCreateAddress(deployer, n + 1), "CREATE DestinationWhitelist"
        );
        _expect(address(d.swapExecutor) == vm.computeCreateAddress(deployer, n + 2), "CREATE SwapExecutorV3");
        _expect(address(d.policyRegistry) == vm.computeCreateAddress(deployer, n + 3), "CREATE PolicyRegistry");
        _expect(address(d.securityGuard) == vm.computeCreateAddress(deployer, n + 4), "CREATE SecurityGuard");
        _expect(address(d.safeBootstrap) == vm.computeCreateAddress(deployer, n + 5), "CREATE SafeBootstrap");
        _expect(address(d.walletFactory) == vm.computeCreateAddress(deployer, n + 6), "CREATE WalletFactory (predicha)");
        _expect(
            address(d.rotationTimelock) == vm.computeCreateAddress(address(d.securityGuard), 1),
            "CREATE RotationTimelock desde el Guard"
        );
        _expect(vm.getNonce(deployer) >= n + 7, "nonce del deployer posterior al deploy");
    }

    function _checkCode(string memory json, SystemDeployer.Deployment memory d) private {
        DeploymentJson.Compiler memory recorded = DeploymentJson.readCompiler(json);
        _checkContractCode(json, recorded, "DenyAllModuleGuard", address(d.denyAllModuleGuard));
        _checkContractCode(json, recorded, "DestinationWhitelist", address(d.destinationWhitelist));
        _checkContractCode(json, recorded, "SwapExecutorV3", address(d.swapExecutor));
        _checkContractCode(json, recorded, "PolicyRegistry", address(d.policyRegistry));
        _checkContractCode(json, recorded, "SecurityGuard", address(d.securityGuard));
        _checkContractCode(json, recorded, "RotationTimelock", address(d.rotationTimelock));
        _checkContractCode(json, recorded, "SafeBootstrap", address(d.safeBootstrap));
        _checkContractCode(json, recorded, "WalletFactory", address(d.walletFactory));
    }

    function _checkContractCode(
        string memory json,
        DeploymentJson.Compiler memory recorded,
        string memory name,
        address a
    ) private {
        string memory key = string.concat(".contracts.", name);
        _expect(a.code.length != 0, string.concat(name, ": tiene codigo"));
        _expect(
            a.codehash == vm.parseJsonBytes32(json, string.concat(key, ".codehash")),
            string.concat(name, ": codehash == JSON")
        );
        _expect(BytecodeCheck.matchesArtifact(a, name), string.concat(name, ": runtime == artefacto (sin inmutables)"));
        _expect(
            DeploymentJson.sameCompiler(recorded, DeploymentJson.compiler(name)),
            string.concat(name, ": compilador y settings == JSON")
        );
        _expect(!vm.parseJsonBool(json, string.concat(key, ".proxy")), string.concat(name, ": sin proxy"));
    }

    // ---------------------------------------------------------------------------------------------
    // Inmutables y cableado

    function _checkWiring(
        ChainConfig.External memory ext,
        SystemDeployer.Params memory p,
        SystemDeployer.Deployment memory d
    ) private {
        SwapExecutorV3 swap = d.swapExecutor;
        _expect(swap.TOKEN0() == ext.usdc, "SwapExecutorV3.TOKEN0 == USDC");
        _expect(swap.TOKEN1() == ext.usdt, "SwapExecutorV3.TOKEN1 == USDT");
        _expect(swap.POOL() == ext.uniswapV3Pool, "SwapExecutorV3.POOL");
        _expect(swap.FACTORY() == ext.uniswapV3Factory, "SwapExecutorV3.FACTORY");

        SecurityGuard g = d.securityGuard;
        _expect(g.POLICY_REGISTRY() == address(d.policyRegistry), "SecurityGuard.POLICY_REGISTRY");
        _expect(g.DESTINATION_WHITELIST() == address(d.destinationWhitelist), "SecurityGuard.DESTINATION_WHITELIST");
        _expect(g.DENY_ALL_MODULE_GUARD() == address(d.denyAllModuleGuard), "SecurityGuard.DENY_ALL_MODULE_GUARD");
        _expect(g.WALLET_FACTORY() == address(d.walletFactory), "SecurityGuard.WALLET_FACTORY == factory real");
        _expect(g.SAFE_L2_SINGLETON() == ext.safeL2Singleton, "SecurityGuard.SAFE_L2_SINGLETON");
        _expect(
            g.SAFE_PROXY_RUNTIME_CODEHASH() == ext.proxyRuntimeCodehash, "SecurityGuard.SAFE_PROXY_RUNTIME_CODEHASH"
        );
        _expect(g.ROTATION_TIMELOCK() == address(d.rotationTimelock), "SecurityGuard.ROTATION_TIMELOCK");
        _expect(g.PERMIT2() == ext.permit2, "SecurityGuard.PERMIT2");
        _expect(g.PREDECESSOR() == p.predecessorGuard, "SecurityGuard.PREDECESSOR");

        _expect(d.rotationTimelock.GUARD() == address(g), "RotationTimelock.GUARD");

        SafeBootstrap b = d.safeBootstrap;
        _expect(b.SECURITY_GUARD() == address(g), "SafeBootstrap.SECURITY_GUARD");
        _expect(b.DENY_ALL_MODULE_GUARD() == address(d.denyAllModuleGuard), "SafeBootstrap.DENY_ALL_MODULE_GUARD");
        _expect(b.SELF() == address(b), "SafeBootstrap.SELF");

        _checkFactory(ext, d);
        _expect(GovernanceSafe.check(ext, p.admin) == bytes32(0), "admin: Governance Safe multisig v1.5.0");
    }

    function _checkFactory(ChainConfig.External memory ext, SystemDeployer.Deployment memory d) private {
        WalletFactory f = d.walletFactory;
        _expect(f.SAFE_PROXY_FACTORY() == ext.safeProxyFactory, "WalletFactory.SAFE_PROXY_FACTORY");
        _expect(f.SAFE_SINGLETON() == ext.safeL2Singleton, "WalletFactory.SAFE_SINGLETON");
        _expect(f.SAFE_BOOTSTRAP() == address(d.safeBootstrap), "WalletFactory.SAFE_BOOTSTRAP");
        _expect(f.SECURITY_GUARD() == address(d.securityGuard), "WalletFactory.SECURITY_GUARD");
        _expect(f.DENY_ALL_MODULE_GUARD() == address(d.denyAllModuleGuard), "WalletFactory.DENY_ALL_MODULE_GUARD");
        _expect(f.ROTATION_TIMELOCK() == address(d.rotationTimelock), "WalletFactory.ROTATION_TIMELOCK");
        _expect(f.POLICY_REGISTRY() == address(d.policyRegistry), "WalletFactory.POLICY_REGISTRY");
        _expect(f.DESTINATION_WHITELIST() == address(d.destinationWhitelist), "WalletFactory.DESTINATION_WHITELIST");
        _expect(f.SAFE_SINGLETON_CODEHASH() == ext.safeL2SingletonCodehash, "WalletFactory.SAFE_SINGLETON_CODEHASH");
        _expect(
            f.SAFE_PROXY_FACTORY_CODEHASH() == ext.safeProxyFactoryCodehash, "WalletFactory.SAFE_PROXY_FACTORY_CODEHASH"
        );
        _expect(
            f.SAFE_PROXY_RUNTIME_CODEHASH() == ext.proxyRuntimeCodehash, "WalletFactory.SAFE_PROXY_RUNTIME_CODEHASH"
        );
        _expect(f.PROXY_CREATION_CODE_HASH() == ext.proxyCreationCodeHash, "WalletFactory.PROXY_CREATION_CODE_HASH");
        _expect(
            f.PROXY_INIT_CODE_HASH()
                == keccak256(
                    abi.encodePacked(
                        ISafeProxyFactory(ext.safeProxyFactory).proxyCreationCode(),
                        uint256(uint160(ext.safeL2Singleton))
                    )
                ),
            "WalletFactory.PROXY_INIT_CODE_HASH"
        );
        _expect(f.CHAIN_ID() == ext.chainId, "WalletFactory.CHAIN_ID");
        _expect(f.validateConfig(SystemDeployer.factoryConfig(ext, d)) == bytes32(0), "WalletFactory.validateConfig");
    }

    // ---------------------------------------------------------------------------------------------
    // Policy inicial

    function _checkPolicy(
        ChainConfig.External memory ext,
        SystemDeployer.Params memory p,
        SystemDeployer.Deployment memory d
    ) private {
        PolicyRegistry r = d.policyRegistry;
        _expect(r.ADMIN() == p.admin, "PolicyRegistry.ADMIN == JSON");
        _expect(r.isRestricted() == (p.mode == PolicyRegistry.Mode.Restricted), "PolicyRegistry.mode == JSON");
        address[] memory onChain = r.guardians();
        bool sameGuardians = onChain.length == p.guardians.length;
        for (uint256 i; sameGuardians && i < p.guardians.length; ++i) {
            sameGuardians = r.isGuardian(p.guardians[i]);
        }
        _expect(sameGuardians, "PolicyRegistry.guardians == JSON");

        (PolicyRegistry.OpPermissionInit[] memory permissions,,) =
            SystemDeployer.policyInit(ext, p, address(d.swapExecutor));
        bool samePermissions = true;
        for (uint256 op; op <= uint256(OpType.Unknown); ++op) {
            for (uint256 role = uint256(Role.User); role <= uint256(Role.Executor); ++role) {
                bool expected;
                for (uint256 i; i < permissions.length; ++i) {
                    if (uint256(permissions[i].op) == op && uint256(permissions[i].role) == role) expected = true;
                }
                if (r.opPermission(OpType(op), Role(role)) != expected) samePermissions = false;
            }
        }
        _expect(samePermissions, "PolicyRegistry: permisos por opType y rol == set V1");
        _expect(r.isSupportedToken(ext.usdc) && r.tokenDecimals(ext.usdc) == 6, "PolicyRegistry: USDC (6)");
        _expect(r.isSupportedToken(ext.usdt) && r.tokenDecimals(ext.usdt) == 6, "PolicyRegistry: USDT (6)");
        _expect(r.isSwapExecutor(address(d.swapExecutor)), "PolicyRegistry: SwapExecutorV3 registrado");
        _expect(r.successorGuardOf(address(d.securityGuard)) == address(0), "PolicyRegistry: sin sucesor del Guard");
        _expect(
            r.successorModuleGuardOf(address(d.denyAllModuleGuard)) == address(0),
            "PolicyRegistry: sin sucesor del module guard"
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Argumentos de constructor

    function _checkConstructorArgs(
        string memory json,
        ChainConfig.External memory ext,
        SystemDeployer.Params memory p,
        SystemDeployer.Deployment memory d
    ) private {
        SystemDeployer.ConstructorArgs memory a = SystemDeployer.constructorArgs(ext, p, d);
        _expectArgs(json, "DenyAllModuleGuard", "");
        _expectArgs(json, "DestinationWhitelist", "");
        _expectArgs(json, "SwapExecutorV3", a.swapExecutor);
        _expectArgs(json, "PolicyRegistry", a.policyRegistry);
        _expectArgs(json, "SecurityGuard", a.securityGuard);
        _expectArgs(json, "RotationTimelock", a.rotationTimelock);
        _expectArgs(json, "SafeBootstrap", a.safeBootstrap);
        _expectArgs(json, "WalletFactory", a.walletFactory);
    }

    function _expectArgs(string memory json, string memory name, bytes memory expected) private {
        bytes memory recorded = vm.parseJsonBytes(json, string.concat(".contracts.", name, ".constructorArgs"));
        _expect(keccak256(recorded) == keccak256(expected), string.concat(name, ": constructorArgs == on-chain"));
    }

    function _expect(bool ok, string memory what) private {
        ++_checks;
        if (!ok) {
            ++_failures;
            console.log("FALLA:", what);
        }
    }
}
