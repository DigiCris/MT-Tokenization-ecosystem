// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Script, console} from "forge-std/Script.sol";
import {VerifyDeployment} from "./VerifyDeployment.s.sol";
import {ChainConfig} from "./lib/ChainConfig.sol";
import {DeploymentJson} from "./lib/DeploymentJson.sol";
import {LocalKeys} from "./lib/LocalKeys.sol";
import {WalletFactory} from "../src/WalletFactory.sol";
import {IDestinationWhitelist} from "../src/interfaces/IDestinationWhitelist.sol";
import {ISafe, Operation} from "../src/interfaces/ISafe.sol";

/// @title SeedLocal
/// @notice Seed determinístico del fork local ([C-SCR-03], P07.T07, P21.T04): usuario de prueba con U, R y S derivadas
///         de `LOCAL_SEED`, su Safe creada por la `WalletFactory` del deploy local con el saltNonce del producto
///         (`keccak256(abi.encode("MTW_SALT_V1", PLATFORM_ID, SEED_WALLET_ID))`, el id de wallet determinístico que
///         calcula `scripts/seed-local`), fondeo con USDC y USDT **reales** del fork (holders reales impersonados en Anvil,
///         sólo en este script) y un destino de prueba agregado a la whitelist con una SafeTx firmada por U y S y
///         activado con un warp de 24 h. Idempotente. Escribe el resultado en `deployments/local.json` (`.seed`).
/// @dev Uso: `pnpm seed-local` (`scripts/seed-local`), después de `pnpm deploy-local`.
contract SeedLocal is Script {
    /// @notice Saldos objetivo de la Safe de prueba.
    uint256 internal constant SEED_USDC = 10_000e6;
    uint256 internal constant SEED_USDT = 5000e6;
    uint256 internal constant ACTIVATION_DELAY = 24 hours;
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
        string memory walletId = vm.envString("SEED_WALLET_ID");
        uint256 saltNonce = uint256(keccak256(abi.encode("MTW_SALT_V1", vm.envString("PLATFORM_ID"), walletId)));
        address safe = factory.predictWalletAddress(u, r, s, saltNonce);
        if (safe.code.length == 0) {
            vm.startBroadcast(LocalKeys.key("seed-relayer"));
            factory.createWallet(u, r, s, saltNonce);
            vm.stopBroadcast();
        }
        _topUp(ext.usdc, USDC_HOLDER, safe, SEED_USDC);
        _topUp(ext.usdt, USDT_HOLDER, safe, SEED_USDT);
        address whitelist = vm.parseJsonAddress(json, ".contracts.DestinationWhitelist.address");
        address destination = LocalKeys.addr("seed-destination");
        _whitelist(safe, whitelist, destination, u, s);
        vm.rpc("evm_mine", "[]");

        vm.serializeJson("local-deployment", json);
        string memory seedJson = _seedJson(safe, u, r, s, saltNonce, walletId, destination);
        vm.writeJson(vm.serializeString("local-deployment", "seed", seedJson), path);
        console.log("Safe de prueba:", safe);
        console.log("U:", u);
        console.log("R:", r);
        console.log("S:", s);
    }

    /// @dev Destino de prueba en la whitelist de la Safe: SafeTx asistida firmada por U y S (las dos claves del seed) y
    ///      transmitida por S (el Guard sólo acepta al ejecutor); después, warp de 24 h para que quede activo.
    function _whitelist(address safe, address whitelist, address destination, address u, address s) internal {
        if (IDestinationWhitelist(whitelist).isWhitelisted(safe, destination)) return;
        bytes memory data = abi.encodeCall(IDestinationWhitelist.addDestination, (destination));
        uint256 safeNonce = ISafe(safe).nonce();
        bytes32 hash = ISafe(safe)
            .getTransactionHash(whitelist, 0, data, Operation.Call, 0, 0, 0, address(0), address(0), safeNonce);
        bytes memory userSig = _sign("seed-user-key", hash);
        bytes memory executorSig = _sign("seed-executor-key", hash);
        bytes memory signatures = u < s ? bytes.concat(userSig, executorSig) : bytes.concat(executorSig, userSig);
        // El Guard exige que la SafeTx asistida la transmita la S de la Safe ("S ejecuta", WrongExecutor).
        LocalKeys.fund(s, 1 ether);
        vm.startBroadcast(LocalKeys.key("seed-executor-key"));
        ISafe(safe)
            .execTransaction(whitelist, 0, data, Operation.Call, 0, 0, 0, address(0), payable(address(0)), signatures);
        vm.stopBroadcast();
        vm.rpc("evm_increaseTime", string.concat("[", vm.toString(ACTIVATION_DELAY + 1), "]"));
    }

    function _sign(string memory label, bytes32 hash) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(LocalKeys.key(label), hash);
        return abi.encodePacked(r, s, v);
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

    function _seedJson(
        address safe,
        address u,
        address r,
        address s,
        uint256 saltNonce,
        string memory walletId,
        address destination
    ) internal pure returns (string memory) {
        return string.concat(
            '{"walletId":"',
            walletId,
            '","destination":"',
            vm.toString(destination),
            '","safe":"',
            vm.toString(safe),
            '","userKey":"',
            vm.toString(u),
            '","recoveryKey":"',
            vm.toString(r),
            '","executor":"',
            vm.toString(s),
            '","saltNonce":"',
            vm.toString(saltNonce),
            '"',
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
