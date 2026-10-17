// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Script, console} from "forge-std/Script.sol";
import {VerifyDeployment} from "./VerifyDeployment.s.sol";
import {ChainConfig} from "./lib/ChainConfig.sol";
import {DeploymentJson} from "./lib/DeploymentJson.sol";
import {LocalKeys} from "./lib/LocalKeys.sol";
import {WalletFactory} from "../src/WalletFactory.sol";

/// @title SeedLocal
/// @notice Seed determinístico del fork local ([C-SCR-03], P07.T07): usuario de prueba con U, R y S derivadas de
///         `LOCAL_SEED`, su Safe creada por la `WalletFactory` del deploy local y fondeo con USDC y USDT **reales** del
///         fork, transferidos por holders reales impersonados en Anvil (sólo en este script). Idempotente: crea la Safe
///         si falta y completa los saldos hasta los objetivos. Escribe el resultado en `deployments/local.json` (`.seed`).
/// @dev Uso: `pnpm seed-local` (`scripts/seed-local`), después de `pnpm deploy-local`.
contract SeedLocal is Script {
    /// @notice Saldos objetivo de la Safe de prueba.
    uint256 internal constant SEED_USDC = 10_000e6;
    uint256 internal constant SEED_USDT = 5000e6;
    uint256 internal constant SALT_NONCE = 0;
    /// @notice Holders reales en el bloque de fork (Morpho Blue para USDC y un hot wallet de exchange para USDT).
    address internal constant USDC_HOLDER = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant USDT_HOLDER = 0x0D0707963952f2fBA59dD06f2b425ace40b492Fe;

    /// @notice El deploy local no verifica: correr antes `pnpm deploy-local`.
    error LocalDeploymentNotVerified(uint256 failures);
    /// @notice El holder real no tiene saldo suficiente en este estado del fork.
    error HolderBalanceTooLow(address holder, uint256 balance, uint256 needed);

    /// @notice Crea y fondea la Safe de prueba.
    function run() external {
        if (!LocalKeys.isAnvil()) revert LocalKeys.NotAnvil();
        ChainConfig.External memory ext = ChainConfig.load();
        string memory path = DeploymentJson.path("local");
        string memory json = vm.readFile(path);
        uint256 failures = new VerifyDeployment().verifyQuietly(json);
        if (failures != 0) revert LocalDeploymentNotVerified(failures);
        WalletFactory factory = WalletFactory(vm.parseJsonAddress(json, ".contracts.WalletFactory.address"));

        address u = LocalKeys.addr("seed-user-key");
        address r = LocalKeys.addr("seed-recovery-key");
        address s = LocalKeys.addr("seed-executor-key");
        address safe = factory.predictWalletAddress(u, r, s, SALT_NONCE);
        if (safe.code.length == 0) {
            vm.startBroadcast(LocalKeys.key("seed-relayer"));
            factory.createWallet(u, r, s, SALT_NONCE);
            vm.stopBroadcast();
        }
        _topUp(ext.usdc, USDC_HOLDER, safe, SEED_USDC);
        _topUp(ext.usdt, USDT_HOLDER, safe, SEED_USDT);
        vm.rpc("evm_mine", "[]");

        vm.serializeJson("local-deployment", json);
        vm.writeJson(vm.serializeString("local-deployment", "seed", _seedJson(safe, u, r, s)), path);
        console.log("Safe de prueba:", safe);
        console.log("U:", u);
        console.log("R:", r);
        console.log("S:", s);
    }

    /// @dev Transfiere desde el holder real (impersonado en Anvil) lo que falta para llegar a `target`.
    function _topUp(address token, address holder, address to, uint256 target) internal {
        uint256 current = IERC20(token).balanceOf(to);
        if (current >= target) return;
        uint256 amount = target - current;
        uint256 holderBalance = IERC20(token).balanceOf(holder);
        if (holderBalance < amount) revert HolderBalanceTooLow(holder, holderBalance, amount);
        string memory h = vm.toString(holder);
        vm.rpc("anvil_impersonateAccount", string.concat('["', h, '"]'));
        vm.rpc("anvil_setBalance", string.concat('["', h, '","0xde0b6b3a7640000"]'));
        string memory data = vm.toString(abi.encodeCall(IERC20.transfer, (to, amount)));
        vm.rpc(
            "eth_sendTransaction",
            string.concat('[{"from":"', h, '","to":"', vm.toString(token), '","data":"', data, '"}]')
        );
        vm.rpc("anvil_stopImpersonatingAccount", string.concat('["', h, '"]'));
    }

    function _seedJson(address safe, address u, address r, address s) internal pure returns (string memory) {
        return string.concat(
            '{"safe":"',
            vm.toString(safe),
            '","userKey":"',
            vm.toString(u),
            '","recoveryKey":"',
            vm.toString(r),
            '","executor":"',
            vm.toString(s),
            '","saltNonce":',
            vm.toString(SALT_NONCE),
            ',"balances":{"usdc":"',
            vm.toString(SEED_USDC),
            '","usdt":"',
            vm.toString(SEED_USDT),
            '"},"funding":{"usdcHolder":"',
            vm.toString(USDC_HOLDER),
            '","usdtHolder":"',
            vm.toString(USDT_HOLDER),
            '"}}'
        );
    }
}
