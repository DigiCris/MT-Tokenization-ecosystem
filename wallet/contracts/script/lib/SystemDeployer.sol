// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {ChainConfig} from "./ChainConfig.sol";
import {PolicyPresets} from "./PolicyPresets.sol";
import {DenyAllModuleGuard} from "../../src/DenyAllModuleGuard.sol";
import {DestinationWhitelist} from "../../src/DestinationWhitelist.sol";
import {SwapExecutorV3} from "../../src/SwapExecutorV3.sol";
import {PolicyRegistry} from "../../src/PolicyRegistry.sol";
import {SecurityGuard} from "../../src/SecurityGuard.sol";
import {RotationTimelock} from "../../src/RotationTimelock.sol";
import {SafeBootstrap} from "../../src/SafeBootstrap.sol";
import {WalletFactory} from "../../src/WalletFactory.sol";

/// @title SystemDeployer
/// @notice Deploy de los contratos del sistema en el orden de §6.1, compartido por `DeployCore` y los tests.
/// @dev Funciones `internal`: los `new` corren en el contexto del llamador (el deployer). El Guard recibe la
///      dirección **predicha** de la `WalletFactory` (`CREATE` del deployer con nonce inicial + 6) y al final se
///      exige que la real coincida; si no, el deploy completo revierte.
library SystemDeployer {
    /// @notice Parámetros del entorno.
    struct Params {
        address admin;
        PolicyRegistry.Mode mode;
        address[] guardians;
        bool v1Policy;
        /// @dev Guard anterior para la importación de roles de [C-GRD-17]; `address(0)` en V1.
        address predecessorGuard;
    }

    /// @notice Contratos desplegados.
    struct Deployment {
        DenyAllModuleGuard denyAllModuleGuard;
        DestinationWhitelist destinationWhitelist;
        SwapExecutorV3 swapExecutor;
        PolicyRegistry policyRegistry;
        SecurityGuard securityGuard;
        RotationTimelock rotationTimelock;
        SafeBootstrap safeBootstrap;
        WalletFactory walletFactory;
    }

    /// @notice Argumentos de constructor ABI-encoded de cada contrato (para el JSON de deployment y su verificación).
    struct ConstructorArgs {
        bytes swapExecutor;
        bytes policyRegistry;
        bytes securityGuard;
        bytes rotationTimelock;
        bytes safeBootstrap;
        bytes walletFactory;
    }

    error FactoryAddressMismatch(address predicted, address actual);

    /// @param ext Contratos externos verificados.
    /// @param p Parámetros del entorno (con `v1Policy`, el registro nace con el set V1 de [C-POL-04]).
    /// @param predictedFactory `vm.computeCreateAddress(deployer, nonceInicial + 6)`.
    function deploy(ChainConfig.External memory ext, Params memory p, address predictedFactory)
        internal
        returns (Deployment memory d)
    {
        d.denyAllModuleGuard = new DenyAllModuleGuard();
        d.destinationWhitelist = new DestinationWhitelist();
        d.swapExecutor = new SwapExecutorV3(ext.usdc, ext.usdt, ext.uniswapV3Pool, ext.uniswapV3Factory);

        (
            PolicyRegistry.OpPermissionInit[] memory permissions,
            PolicyRegistry.TokenInit[] memory tokens,
            address[] memory executors
        ) = policyInit(ext, p, address(d.swapExecutor));
        d.policyRegistry = new PolicyRegistry(p.admin, p.mode, p.guardians, permissions, tokens, executors);

        d.securityGuard = new SecurityGuard(
            address(d.policyRegistry),
            address(d.destinationWhitelist),
            address(d.denyAllModuleGuard),
            predictedFactory,
            ext.safeL2Singleton,
            ext.proxyRuntimeCodehash,
            ext.permit2,
            p.predecessorGuard
        );
        d.rotationTimelock = RotationTimelock(d.securityGuard.ROTATION_TIMELOCK());
        d.safeBootstrap = new SafeBootstrap(address(d.securityGuard), address(d.denyAllModuleGuard));
        d.walletFactory = new WalletFactory(factoryConfig(ext, d));
        if (address(d.walletFactory) != predictedFactory) {
            revert FactoryAddressMismatch(predictedFactory, address(d.walletFactory));
        }
    }

    /// @notice Estado inicial del `PolicyRegistry`: con `v1Policy`, el set V1 de [C-POL-04] y el executor.
    function policyInit(ChainConfig.External memory ext, Params memory p, address swapExecutor)
        internal
        pure
        returns (
            PolicyRegistry.OpPermissionInit[] memory permissions,
            PolicyRegistry.TokenInit[] memory tokens,
            address[] memory executors
        )
    {
        if (p.v1Policy) {
            permissions = PolicyPresets.v1Permissions();
            tokens = PolicyPresets.v1Tokens(ext.usdc, ext.usdt);
            executors = new address[](1);
            executors[0] = swapExecutor;
        }
    }

    /// @notice Configuración de la `WalletFactory` para los contratos de `d` ([C-FAC-02]).
    function factoryConfig(ChainConfig.External memory ext, Deployment memory d)
        internal
        pure
        returns (WalletFactory.Config memory)
    {
        return WalletFactory.Config({
            safeProxyFactory: ext.safeProxyFactory,
            safeSingleton: ext.safeL2Singleton,
            safeBootstrap: address(d.safeBootstrap),
            securityGuard: address(d.securityGuard),
            denyAllModuleGuard: address(d.denyAllModuleGuard),
            rotationTimelock: address(d.rotationTimelock),
            policyRegistry: address(d.policyRegistry),
            destinationWhitelist: address(d.destinationWhitelist),
            safeSingletonCodehash: ext.safeL2SingletonCodehash,
            safeProxyFactoryCodehash: ext.safeProxyFactoryCodehash,
            safeProxyRuntimeCodehash: ext.proxyRuntimeCodehash,
            proxyCreationCodeHash: ext.proxyCreationCodeHash,
            chainId: ext.chainId
        });
    }

    /// @notice Argumentos de constructor con los que `deploy` crea cada contrato de `d`.
    function constructorArgs(ChainConfig.External memory ext, Params memory p, Deployment memory d)
        internal
        pure
        returns (ConstructorArgs memory a)
    {
        a.swapExecutor = abi.encode(ext.usdc, ext.usdt, ext.uniswapV3Pool, ext.uniswapV3Factory);
        (
            PolicyRegistry.OpPermissionInit[] memory permissions,
            PolicyRegistry.TokenInit[] memory tokens,
            address[] memory executors
        ) = policyInit(ext, p, address(d.swapExecutor));
        a.policyRegistry = abi.encode(p.admin, p.mode, p.guardians, permissions, tokens, executors);
        a.securityGuard = abi.encode(
            address(d.policyRegistry),
            address(d.destinationWhitelist),
            address(d.denyAllModuleGuard),
            address(d.walletFactory),
            ext.safeL2Singleton,
            ext.proxyRuntimeCodehash,
            ext.permit2,
            p.predecessorGuard
        );
        a.rotationTimelock = abi.encode(address(d.securityGuard));
        a.safeBootstrap = abi.encode(address(d.securityGuard), address(d.denyAllModuleGuard));
        a.walletFactory = abi.encode(factoryConfig(ext, d));
    }
}
