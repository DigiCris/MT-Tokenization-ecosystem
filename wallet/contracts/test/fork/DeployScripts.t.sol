// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {VmSafe} from "forge-std/Vm.sol";
import {ForkTest} from "../utils/ForkTest.sol";
import {SafeHelpers} from "../utils/SafeHelpers.sol";
import {DeploymentJson} from "../../script/lib/DeploymentJson.sol";
import {GovernanceSafe} from "../../script/lib/GovernanceSafe.sol";
import {LocalKeys} from "../../script/lib/LocalKeys.sol";
import {SystemDeployer} from "../../script/lib/SystemDeployer.sol";
import {VerifyDeployment} from "../../script/VerifyDeployment.s.sol";
import {PolicyRegistry} from "../../src/PolicyRegistry.sol";
import {ISafe, ISafeProxyFactory} from "../../src/interfaces/ISafe.sol";

/// @notice Scripts de deploy ([C-SCR-01], [C-SCR-02]) sobre el fork: el sistema se despliega con el mismo código
///         que `DeployCore` (`SystemDeployer`), el JSON se arma con el mismo `DeploymentJson.build` y
///         `VerifyDeployment.verify` da OK; cada alteración del JSON o de la cadena produce fallas.
/// @dev `VerifyDeployment` compara el runtime con los artefactos de release de `out/`; `forge coverage` despliega
///      un build sin optimizador, así que en ese contexto la suite se omite (corre completa en `forge test`; la
///      cobertura de `src/` no depende de ella).
contract DeployScriptsTest is ForkTest, SafeHelpers {
    string internal constant COMMIT = "17afffa171bd3d28f5096dab302e2f8e9a4d9835";

    VerifyDeployment internal verifier;
    SystemDeployer.Deployment internal d;
    address internal governance;
    uint64 internal nonce;
    string internal json;

    function setUp() public {
        if (vm.isContext(VmSafe.ForgeContext.Coverage)) vm.skip(true);
        _fork();
        address[] memory owners = new address[](3);
        owners[0] = makeAddr("gov-owner-1");
        owners[1] = makeAddr("gov-owner-2");
        owners[2] = makeAddr("gov-owner-3");
        governance = GovernanceSafe.create(ext, owners, 2, 7);
        address[] memory guardians = new address[](2);
        guardians[0] = makeAddr("guardian-1");
        guardians[1] = makeAddr("guardian-2");
        SystemDeployer.Params memory p =
            SystemDeployer.Params(governance, PolicyRegistry.Mode.Restricted, guardians, true, address(0));
        nonce = vm.getNonce(address(this));
        d = SystemDeployer.deploy(ext, p, vm.computeCreateAddress(address(this), nonce + 6));
        json = DeploymentJson.build(ext, DeploymentJson.Header("local", address(this), nonce, COMMIT, false), p, d);
        verifier = new VerifyDeployment();
    }

    function test_verifyPassesForFreshDeployment() public {
        assertEq(verifier.verify(json), 0, "sin diferencias");
        assertGt(verifier.checks(), 100, "verificaciones");
        assertEq(vm.parseJsonUint(json, ".chainId"), 8453);
        assertEq(vm.parseJsonAddress(json, ".contracts.WalletFactory.address"), address(d.walletFactory));
        assertEq(vm.parseJsonBytes32(json, ".contracts.SecurityGuard.codehash"), address(d.securityGuard).codehash);
        assertEq(vm.parseJsonString(json, ".git.commit"), COMMIT);
        assertEq(vm.parseJsonString(json, ".compiler.solc"), "0.8.37+commit.f401782d");
        assertEq(vm.parseJsonString(json, ".compiler.evmVersion"), "cancun");
        assertEq(vm.parseJsonUint(json, ".compiler.optimizerRuns"), 200);
        assertFalse(vm.parseJsonBool(json, ".contracts.SecurityGuard.proxy"));
    }

    // ---------------------------------------------------------------------------------------------
    // Alteraciones del JSON

    function test_detectsCodehashTampering() public {
        string memory bad =
            vm.replace(json, vm.toString(address(d.securityGuard).codehash), vm.toString(bytes32(uint256(1))));
        assertEq(verifier.verify(bad), 1);
    }

    function test_detectsAddressTampering() public {
        string memory bad = vm.replace(json, vm.toString(address(d.safeBootstrap)), vm.toString(makeAddr("otro")));
        assertGt(verifier.verify(bad), 1);
    }

    function test_detectsConstructorArgsTampering() public {
        // DenyAllModuleGuard y DestinationWhitelist no tienen argumentos.
        string memory bad = vm.replace(json, '"constructorArgs":"0x"', '"constructorArgs":"0x00"');
        assertEq(verifier.verify(bad), 2);
    }

    function test_detectsPolicyTampering() public {
        string memory bad = vm.replace(json, '"mode":"Restricted"', '"mode":"Bootstrap"');
        // modo del registro + argumentos de constructor del registro.
        assertEq(verifier.verify(bad), 2);
        bad = vm.replace(json, vm.toString(governance), vm.toString(makeAddr("admin-falso")));
        assertGt(verifier.verify(bad), 2);
    }

    function test_detectsNonceTampering() public {
        string memory bad = vm.replace(
            json,
            string.concat('"deployerNonce":', vm.toString(nonce)),
            string.concat('"deployerNonce":', vm.toString(nonce + 1))
        );
        // las siete direcciones CREATE del deployer (el RotationTimelock sale del Guard).
        assertEq(verifier.verify(bad), 7);
    }

    function test_detectsCompilerTampering() public {
        string memory bad = vm.replace(json, '"optimizerRuns":200', '"optimizerRuns":201');
        assertEq(verifier.verify(bad), 8, "un contrato por cada artefacto");
    }

    function test_detectsWrongChainOrForkBlock() public {
        string memory bad = vm.replace(json, '"chainId":8453', '"chainId":1');
        assertEq(verifier.verify(bad), 1);
        bad = vm.replace(
            json,
            string.concat('"forkBlock":', vm.toString(ext.forkBlock)),
            string.concat('"forkBlock":', vm.toString(ext.forkBlock + 1))
        );
        assertEq(verifier.verify(bad), 1);
    }

    // ---------------------------------------------------------------------------------------------
    // Alteraciones de la cadena

    function test_detectsForeignRuntime() public {
        vm.etch(address(d.denyAllModuleGuard), hex"00");
        // codehash, runtime == artefacto y validateConfig de la factory.
        assertGe(verifier.verify(json), 2);
    }

    function test_detectsRegistryStateChange() public {
        vm.store(address(d.policyRegistry), bytes32(0), bytes32(0));
        assertFalse(d.policyRegistry.isRestricted());
        assertEq(verifier.verify(json), 1);
    }

    function test_detectsExternalContractChange() public {
        vm.etch(ext.permit2, hex"00");
        assertEq(verifier.verify(json), 1);
    }

    function test_detectsExternalProxyImplementationChange() public {
        bytes32 slot = vm.parseJsonBytes32(
            vm.readFile(string.concat(vm.projectRoot(), "/../config/chains/base-mainnet.json")),
            ".contracts.usdc.implementation.slot"
        );
        vm.store(ext.usdc, slot, bytes32(uint256(uint160(makeAddr("otra-implementacion")))));
        assertEq(verifier.verify(json), 1);
    }

    function test_detectsGovernanceWithoutMultisig() public {
        vm.mockCall(governance, abi.encodeWithSelector(ISafe.getThreshold.selector), abi.encode(uint256(1)));
        assertEq(verifier.verify(json), 1);
    }

    // ---------------------------------------------------------------------------------------------
    // Librerías de los scripts

    function test_networkNames() public {
        vm.setEnv("DEPLOY_NETWORK", "fork/staging");
        assertEq(DeploymentJson.network(), "fork/staging");
        assertFalse(DeploymentJson.isSeedNetwork("fork/staging"));
        assertTrue(DeploymentJson.isSeedNetwork("ci"));
        assertTrue(DeploymentJson.isSeedNetwork("local"));
        vm.setEnv("DEPLOY_NETWORK", "base-mainnet");
        vm.expectRevert(abi.encodeWithSelector(DeploymentJson.UnknownNetwork.selector, "base-mainnet"));
        this.network();
        vm.setEnv("DEPLOY_NETWORK", "local");
    }

    function network() external view returns (string memory) {
        return DeploymentJson.network();
    }

    function test_governanceSafeCheck() public {
        assertEq(GovernanceSafe.check(ext, governance), bytes32(0));
        address[] memory owners = new address[](3);
        owners[0] = makeAddr("g1");
        owners[1] = makeAddr("g2");
        owners[2] = makeAddr("g3");
        address predicted = GovernanceSafe.predict(ext, owners, 2, 99);
        assertEq(GovernanceSafe.create(ext, owners, 2, 99), predicted, "CREATE2 predicho");
        assertEq(GovernanceSafe.check(ext, predicted), bytes32(0));
        assertEq(GovernanceSafe.check(ext, makeAddr("eoa")), bytes32("PROXY_CODEHASH"));
        assertEq(GovernanceSafe.check(ext, GovernanceSafe.create(ext, owners, 1, 100)), bytes32("THRESHOLD"));
        assertEq(GovernanceSafe.check(ext, GovernanceSafe.create(ext, owners, 3, 101)), bytes32("OWNERS"));
        // singleton L1 de Safe v1.5.0: también válido como Governance Safe.
        address l1 = ISafeProxyFactory(ext.safeProxyFactory)
            .createProxyWithNonceL2(ext.safeSingleton, GovernanceSafe.initializer(owners, 2), 102);
        assertEq(GovernanceSafe.check(ext, l1), bytes32(0));
        // proxy canónico con un singleton que no es una Safe.
        address bogus = ISafeProxyFactory(ext.safeProxyFactory).createProxyWithNonceL2(ext.permit2, "", 103);
        assertEq(GovernanceSafe.check(ext, bogus), bytes32("SINGLETON"));
    }

    function test_localKeysOnlyOnAnvil() public {
        vm.setEnv("LOCAL_SEED", "0x6d74772d746573742d736565642d6e6f742d757365642d616e7977686572652e");
        if (LocalKeys.isAnvil()) {
            uint256 k = LocalKeys.key("deployer");
            assertEq(k, LocalKeys.key("deployer"), "deterministica");
            assertTrue(k != LocalKeys.key("governance-owner-1"), "una clave por label");
            assertEq(LocalKeys.addr("deployer"), vm.addr(k));
        } else {
            vm.expectRevert(LocalKeys.NotAnvil.selector);
            this.localKey("deployer");
            vm.expectRevert(LocalKeys.NotAnvil.selector);
            this.fund(makeAddr("x"));
        }
    }

    function localKey(string memory label) external returns (uint256) {
        return LocalKeys.key(label);
    }

    function fund(address account) external {
        LocalKeys.fund(account, 1 ether);
    }
}
