// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ForkTest} from "../utils/ForkTest.sol";
import {ChainConfig} from "../../script/lib/ChainConfig.sol";

interface ISafeVersion {
    function VERSION() external view returns (string memory);
}

interface IProxyCreationCode {
    function proxyCreationCode() external pure returns (bytes memory);
}

interface IPoolView {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
}

interface IFactoryView {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @notice P03.T03: todas las dependencias externas, verificadas en el bloque de fork contra `base-mainnet.json`.
contract ExternalContractsTest is ForkTest {
    function setUp() public {
        _fork();
    }

    function test_blockHashMatchesConfig() public view {
        // El hash de bloque es keccak256 del header RLP.
        assertEq(keccak256(vm.getRawBlockHeader(ext.forkBlock)), ext.forkBlockHash);
    }

    function test_everyContractHasExpectedCodehash() public view {
        string[] memory keys = ChainConfig.contractKeys();
        assertGe(keys.length, 16, "contratos en el config");
        for (uint256 i; i < keys.length; ++i) {
            (address addr, bytes32 codehash) = ChainConfig.contractAt(keys[i]);
            assertGt(addr.code.length, 0, string.concat(keys[i], ": sin codigo"));
            assertEq(addr.codehash, codehash, string.concat(keys[i], ": codehash"));
        }
    }

    function test_safeSingletonsAndFactory() public view {
        assertEq(ISafeVersion(ext.safeL2Singleton).VERSION(), "1.5.0");
        assertEq(keccak256(IProxyCreationCode(ext.safeProxyFactory).proxyCreationCode()), ext.proxyCreationCodeHash);
    }

    function test_tokens() public view {
        assertEq(IERC20Metadata(ext.usdc).decimals(), 6);
        assertEq(IERC20Metadata(ext.usdt).decimals(), 6);
        assertEq(IERC20Metadata(ext.usdc).symbol(), "USDC");
        assertEq(IERC20Metadata(ext.usdt).symbol(), "USDT");
        assertEq(IERC20Metadata(ext.usdc).name(), "USD Coin");
        assertEq(IERC20Metadata(ext.usdt).name(), "Tether USD");
    }

    function test_uniswapPool() public view {
        IPoolView pool = IPoolView(ext.uniswapV3Pool);
        assertEq(IFactoryView(ext.uniswapV3Factory).getPool(ext.usdc, ext.usdt, 100), address(pool));
        assertEq(pool.token0(), ext.usdc);
        assertEq(pool.token1(), ext.usdt);
        assertEq(pool.fee(), 100);
        assertGt(pool.liquidity(), 0);
    }
}
