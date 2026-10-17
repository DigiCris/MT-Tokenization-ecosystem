# Triage de Semgrep

`ci/scripts/ci-security.sh` corre Semgrep (imagen fijada por digest) con los rulesets `p/javascript`, `p/typescript`, `p/nodejs`, `p/react`, `p/secrets` y `p/smart-contracts` del registry más las reglas propias de `ci/semgrep/`, y falla ante cualquier hallazgo (`--error`).

## Reglas excluidas

Las reglas de la categoría `performance` de `p/smart-contracts` son sugerencias de ahorro de gas, no de seguridad, y algunas contradicen decisiones explícitas del proyecto. Se excluyen por ID:

| Regla | Por qué se excluye |
|---|---|
| `solidity.performance.non-payable-constructor` | Propone constructores `payable` para ahorrar gas; los contratos del sistema no deben recibir ETH al desplegarse. |
| `solidity.performance.use-nested-if` | Prefiere `if` anidados a condiciones con `&&`; las condiciones compuestas siguen el texto del spec y se testean rama por rama. |
| `solidity.performance.array-length-outside-loop` | Cachear `length` en loops acotados (inicialización del registro, firmas del threshold) no cambia la seguridad. |
| `solidity.performance.unnecessary-checked-arithmetic-in-loop` | Propone `unchecked` en contadores de loops; se mantiene la aritmética chequeada. |

Ninguna regla de las categorías `security` o `correctness` se excluye.

## Hallazgos suprimidos en el código

Cada supresión es un comentario `// nosemgrep: <regla>` en la línea anterior, con su justificación:

| Regla | Ubicación | Por qué no es una vulnerabilidad |
|---|---|---|
| `solidity.security.basic-arithmetic-underflow` | `SecurityGuard.checkAfterExecution` (`depth - 1`) | La resta va después de `if (depth == 0) return;` y la aritmética es chequeada (0.8.x): no puede subdesbordar. |
| `solidity.security.uniswap-callback-not-protected` | `SwapExecutorV3.uniswapV3SwapCallback` | El callback revierte si `msg.sender != POOL` (el pool canónico, verificado contra la factory en el constructor) o si no hay un swap en curso; sólo cobra exactamente `amountIn` al `msg.sender` del swap ([C-SWP-03]). La regla busca la librería `CallbackValidation` del periphery de Uniswap, que no aplica a un executor con un único pool inmutable. |
