// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";
import {DeploymentJson} from "./DeploymentJson.sol";

/// @title BytecodeCheck
/// @notice Compara el runtime on-chain de un contrato con el `deployedBytecode` del artefacto compilado desde las
///         fuentes actuales: las posiciones de inmutables (`immutableReferences`) se ponen en cero antes de comparar
///         y los valores de los inmutables se verifican aparte por sus getters ([C-SCR-02]).
library BytecodeCheck {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Campos en orden alfabético, como los decodifica `parseJson`.
    struct ImmutableRef {
        uint256 length;
        uint256 start;
    }

    /// @notice true si el código de `target` es el del artefacto `contractName` salvo los inmutables.
    function matchesArtifact(address target, string memory contractName) internal view returns (bool) {
        string memory json = DeploymentJson.artifact(contractName);
        bytes memory expected = VM.parseJsonBytes(json, ".deployedBytecode.object");
        bytes memory actual = target.code;
        if (actual.length != expected.length) return false;
        string[] memory ids = _immutableIds(json);
        for (uint256 i; i < ids.length; ++i) {
            ImmutableRef[] memory refs = abi.decode(
                VM.parseJson(json, string.concat(".deployedBytecode.immutableReferences.", ids[i])), (ImmutableRef[])
            );
            for (uint256 j; j < refs.length; ++j) {
                uint256 end = refs[j].start + refs[j].length;
                if (end > actual.length) return false;
                for (uint256 k = refs[j].start; k < end; ++k) {
                    actual[k] = 0;
                }
            }
        }
        return keccak256(actual) == keccak256(expected);
    }

    /// @dev `parseJsonKeys` revierte con un objeto vacío (contrato sin inmutables). Un error de lectura real deja
    ///      las posiciones sin enmascarar y la comparación falla: nunca da un falso OK.
    function _immutableIds(string memory json) private pure returns (string[] memory ids) {
        try VM.parseJsonKeys(json, ".deployedBytecode.immutableReferences") returns (string[] memory keys) {
            ids = keys;
        } catch {
            ids = new string[](0);
        }
    }
}
