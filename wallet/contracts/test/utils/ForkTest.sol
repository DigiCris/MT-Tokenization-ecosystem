// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ChainConfig} from "../../script/lib/ChainConfig.sol";

/// @notice Base de los tests sobre el fork de Base: siempre en el bloque fijado de `config/chains/base-mainnet.json`.
/// @dev RPC: `FORK_RPC_URL` (CI: el RPC archive) o, si falta, `LOCAL_RPC_URL` / Anvil local (`pnpm fork:start`).
///      Al fijar el bloque, el estado es el del bloque de fork aunque el Anvil local haya minado bloques después.
abstract contract ForkTest is Test {
    ChainConfig.External internal ext;
    uint256 internal forkId;

    function _fork() internal {
        ext = ChainConfig.load();
        string memory url = vm.envOr("FORK_RPC_URL", vm.envOr("LOCAL_RPC_URL", string("http://127.0.0.1:8545")));
        forkId = vm.createSelectFork(url, ext.forkBlock);
        assertEq(block.chainid, ext.chainId, "chainId del fork");
        assertEq(block.number, ext.forkBlock, "bloque del fork");
    }
}
