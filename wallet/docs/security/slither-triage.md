# Triage de Slither

Slither 0.11.6 sobre `contracts/src` con `contracts/slither.config.json` (excluye `dependencies/`, `test/` y `script/`). El gate de CI es `slither . --config-file slither.config.json --fail-medium`, que falla ante cualquier hallazgo Medium o High sin triage (en 0.11.6 `--fail-medium` ya cubre High y no se puede combinar con `--fail-high`).

Cada supresión está en el código, junto a la línea o el bloque, con su justificación (`// slither-disable-next-line <detector>` o `// slither-disable-start/end <detector>`). Este documento las consolida para P04.SEC, P05.SEC, P06.SEC, P07 y la auditoría (P27). La revisión manual de cada llamada externa está en [external-calls-review.md](external-calls-review.md).

Última corrida (2026-10-17, código de P05/P06): 47 contratos, 102 detectores, 67 resultados, todos informativos o Low de la última tabla; ningún Medium/High abierto.

## Hallazgos High y Medium suprimidos (falsos positivos por diseño)

| Detector | Severidad | Ubicación | Por qué no es una vulnerabilidad |
|---|---|---|---|
| `arbitrary-send-erc20` | High | `SwapExecutorV3.uniswapV3SwapCallback` (`safeTransferFrom(payer, POOL, delta)`) | `payer` es el `msg.sender` del `swap` en curso, guardado en transient storage; el callback revierte si no lo llama el `POOL` canónico o si no hay un swap activo, y sólo cobra exactamente `amountIn` ([C-SWP-03], [C-SWP-05]). Un tercero no puede iniciar un cobro a otra dirección. |
| `reentrancy-balance` (×4) | High | `SwapExecutorV3.swap` | Los saldos de `msg.sender` se miden antes y después del `swap` del pool **a propósito**: son las post-condiciones de débito exacto (`amountIn`) y crédito mínimo (`minAmountOut`). `swap` es `nonReentrant` (transient) y durante la llamada sólo corre código del pool canónico, de USDC/USDT y del propio callback; una alteración de saldos durante la llamada haría fallar las post-condiciones, nunca las relajaría. El Guard repite las mismas post-condiciones del lado de la Safe ([C-GRD-09]). |
| `incorrect-equality` (×2) | Medium | `RotationTimelock.propose` y `RotationTimelock.activeProposal` | Comparan el enum de estado de la propuesta (`Status.Pending`), no saldos ni valores que un tercero pueda manipular. |
| `reentrancy-no-eth` | Medium | `WalletFactory.createWallet` (`isWallet` escrito después de `createProxyWithNonceL2`) | `createWallet` es `nonReentrant`; durante la creación sólo corre código verificado por codehash (SafeProxyFactory, SafeL2, `SafeBootstrap` y el Guard), y `isWallet` se marca recién después de verificar la Safe en la misma transacción ([C-FAC-05]). |
| `unused-return` | Medium | `SecurityGuard._evaluate` (`decodeBytes32`), `SecurityGuard._classifyWhitelist` (`decodeAddress`) | El decoder se llama sólo para exigir la longitud exacta y el encoding sin ambigüedad de `cancel(bytes32)` y `removeDestination(address)` ([C-DEC-02]); el valor no se usa. |
| `unused-return` | Medium | `SecurityGuard._classifyRotationExecute` (`prevOwner` de `decodeSwapOwner`) | `prevOwner` lo valida la propia Safe en `swapOwner` (puntero de la lista enlazada de owners). |
| `unused-return` | Medium | `SecurityGuard._hasModules`, `WalletFactory._verify` (`getModulesPaginated`) | Sólo importa si existe al menos un módulo; el cursor `next` no se usa. |
| `unused-return` | Medium | `SecurityGuard.evaluateAssisted` (`try this.classifyAssisted(...)`) | Sólo importa si la clasificación revierte (y con qué error); el opType devuelto no se usa en esa vista. |

## Hallazgos Low suprimidos

| Detector | Ubicación | Justificación |
|---|---|---|
| `missing-zero-check` | `SecurityGuard` constructor (`predecessor`) | `address(0)` es válido: el primer Guard (V1) no tiene predecesor ([C-GRD-17]). |
| `missing-zero-check` | `SwapExecutorV3.swap` (`tokenIn`) | `tokenOutFor(tokenIn)` revierte con `UnsupportedToken` para `address(0)` antes de cualquier efecto. |
| `reentrancy-benign` | `SwapExecutorV3.swap` (limpieza del transient después del `swap` del pool) | Es la limpieza de `_payer`, `_tokenIn` y `_amountIn`; el transient además se borra al final de la transacción. |

## Hallazgos Low e Informational que se mantienen visibles

No fallan el gate y se revisan en cada auditoría:

| Detector | Severidad | Dónde | Comentario |
|---|---|---|---|
| `timestamp` (×10) | Low | `DestinationWhitelist`, `PolicyRegistry`, `RotationTimelock`, `SecurityGuard`, `SwapExecutorV3` | Timelocks de 24 h y 48 h y deadlines de swap: comparar contra `block.timestamp` es la semántica pedida; los validadores sólo lo desplazan segundos frente a demoras de horas. |
| `assembly` (×7) | Informational | `CallDecoder`, `SafeSignatureParser`, `SecurityGuard`, `WalletFactory` | Lectura de firmas con el layout de Safe, `mcopy` de argumentos y transient storage (`tload`/`tstore`); todos los bloques son `memory-safe` y tienen tests propios. |
| `low-level-calls` (×1) | Informational | `SecurityGuard._tryGuardSlot` | `staticcall` deliberada para leer el slot de guard de un `SafeProxy` sin revertir nunca (un `try`/`catch` no captura retornos malformados); sólo lectura, retorno de longitud exacta decodificado como tipos estáticos ([external-calls-review.md](external-calls-review.md#nota-sobre-_tryguardslot)). |
| `cyclomatic-complexity` (×2) | Informational | `SecurityGuard._evaluate`, `RotationTimelock.propose` | Clasificación exhaustiva por reglas del spec; cada rama está cubierta por tests unitarios y de integración (cobertura de ramas 100 % en `src/`). |
| `naming-convention` (×47) | Informational | inmutables en mayúsculas expuestos como getters de interfaz (`ADMIN()`, `GUARD()`, `POLICY_REGISTRY()`…) y parámetros con `_` | Convención del proyecto: los inmutables públicos van en mayúsculas igual que en Safe y OpenZeppelin. |

`shadowing-local` en `ISafe.getTransactionHash` (el parámetro `nonce` sombreaba `nonce()`) se corrigió renombrando el parámetro a `_nonce`, como en la interfaz oficial de Safe.
