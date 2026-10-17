// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {ISafe} from "../../src/interfaces/ISafe.sol";

/// @notice Predecesor de un owner en la lista enlazada de la Safe (para `swapOwner`/`removeOwner`).
library SafeOwners {
    address internal constant SENTINEL = address(0x1);

    function prevOwner(ISafe safe, address owner) internal view returns (address prev) {
        address[] memory owners = safe.getOwners();
        prev = SENTINEL;
        for (uint256 i; i < owners.length; ++i) {
            if (owners[i] == owner) return prev;
            prev = owners[i];
        }
        revert("SafeOwners: no es owner");
    }
}
