# Triage de Slither

Slither 0.11.6 sobre `contracts/src` con `contracts/slither.config.json`, que excluye `dependencies/`, `test/` y `script/`.

El gate de CI es `slither . --config-file slither.config.json --fail-medium`: falla ante cualquier hallazgo Medium o High visible. En 0.11.6, `--fail-medium` ya cubre High y no se puede combinar con `--fail-high`.

Cada supresión está en el código, en la línea afectada, con su justificación al lado (`// slither-disable-next-line <detector>`, o `slither-disable-start/end` cuando el hallazgo se ancla en un bloque). Este documento las consolida para P04.SEC, P05.SEC, P06.SEC, P07 y la auditoría (P27). La revisión manual de cada llamada externa está en [external-calls-review.md](external-calls-review.md).

## Estado y control de las supresiones

Última corrida (2026-10-17, código de P07): 47 contratos, 102 detectores y 81 hallazgos.

- **14 suprimidos** en el código: 3 High, 9 Medium y 2 Low.
- **67 visibles:** todos Low o Informational. Están en la última tabla.

Slither suprime un hallazgo si **cualquiera** de sus elementos cae en una línea ignorada, y agrupa en un mismo hallazgo los efectos posteriores a una llamada. Por eso una supresión podría absorber un problema nuevo sin que el gate lo vea.

Para evitarlo, `contracts/slither-suppressed.json` es el baseline de los suprimidos:

- Se guarda el `id` de Slither, que se calcula sin números de línea y cambia cuando cambia el código de la función afectada.
- Se guardan también el detector, el impacto y la ubicación.
- `node ci/scripts/slither-baseline.mjs check` obtiene los suprimidos (los hallazgos con `--show-ignored-findings` menos los visibles) y falla ante cualquier diferencia. Corre en `ci-contracts.sh`.
- Un suprimido nuevo o modificado se revisa, se justifica acá y se acepta con `node ci/scripts/slither-baseline.mjs update`.

## Hallazgos High y Medium suprimidos (falsos positivos por diseño)

| Detector | Severidad | Ubicación | Por qué no es una vulnerabilidad |
|---|---|---|---|
| `arbitrary-send-erc20` | High | `SwapExecutorV3.uniswapV3SwapCallback` (`safeTransferFrom(payer, POOL, delta)`) | `payer` es el `msg.sender` del `swap` en curso, guardado en transient storage. El callback revierte si no lo llama el `POOL` canónico (verificado contra la factory en el constructor) o si no hay un swap activo, y sólo cobra exactamente `amountIn` ([C-SWP-03], [C-SWP-05]). El pool v3 sólo llama al callback de su propio `msg.sender` y tiene lock. Un tercero no puede iniciar un cobro a otra dirección. |
| `reentrancy-balance` (×2) | High | `SwapExecutorV3.swap`: lecturas de saldo antes del `swap` del pool, `inBefore` y `outBefore` | Ver [Detalle de `reentrancy-balance`](#detalle-de-reentrancy-balance). |
| `incorrect-equality` (×2) | Medium | `RotationTimelock.propose` y `RotationTimelock.activeProposal` | Comparan el enum de estado de la propuesta (`Status.Pending`), no saldos ni tiempos. Causa del aviso: en 0.11.6 el detector usa `block.timestamp` como fuente de taint, y Slither no distingue los campos de `Proposal`, que guarda `createdAt`/`executableAt` desde `block.timestamp`. Por eso las mismas líneas también aparecen en `timestamp`. No conviene reescribir con `!=` sólo para esquivar el detector. |
| `reentrancy-no-eth` | Medium | `WalletFactory.createWallet`: `isWallet` se escribe después de `createProxyWithNonceL2` | Ver [Detalle de `reentrancy-no-eth`](#detalle-de-reentrancy-no-eth). |
| `unused-return` | Medium | `SecurityGuard._evaluate` (`decodeBytes32`) y `SecurityGuard._classifyWhitelist` (`decodeAddress`) | El decoder se llama sólo para exigir longitud exacta y encoding sin ambigüedad de `cancel(bytes32)` y `removeDestination(address)` ([C-DEC-02]). `abi.decode` rechaza bits altos en `address`. El valor no se usa. |
| `unused-return` | Medium | `SecurityGuard._classifyRotationExecute` (`prevOwner` de `decodeSwapOwner`) | `prevOwner` lo valida la propia Safe en `swapOwner` (GS205, puntero de la lista enlazada de owners). Con `safeTxGas = gasPrice = 0`, la ejecución entera revierte. |
| `unused-return` | Medium | `SecurityGuard._hasModules` y `WalletFactory._verify` (`getModulesPaginated(SENTINEL, 1)`) | Devuelve longitud ≥ 1 si y sólo si hay algún módulo. El cursor `next` no se usa. |
| `unused-return` | Medium | `SecurityGuard.evaluateAssisted` (`try this.classifyAssisted(...)`) | Sólo importa si la clasificación revierte y con qué error. El opType devuelto no se usa en esa vista. |

### Detalle de `reentrancy-balance`

Los saldos de `msg.sender` se miden antes y después del `swap` del pool a propósito: son las post-condiciones del executor.

- **`tokenIn`:** es una igualdad estricta (débito exacto de `amountIn`), así que falla cerrado en los dos sentidos. El test del pool malicioso que cobra dos veces lo prueba.
- **`tokenOut`:** una transferencia entrante a `msg.sender` durante la llamada inflaría `amountOut` y relajaría `amountOut >= minAmountOut`. Igual no es explotable:
  - `swap` es `nonReentrant` (transient);
  - durante la llamada sólo corren el pool canónico (con lock propio), USDC/USDT y el callback;
  - una donación sólo aumenta lo que recibe quien paga.

En el camino asistido, el Guard además exige post-condiciones propias desde el lado de la Safe ([C-GRD-09]): débito ≤ `amountIn`, crédito ≥ `minAmountOut` y allowance 0 hacia el executor.

### Detalle de `reentrancy-no-eth`

0.11.6 ya descuenta el `nonReentrant` de `createWallet`. El aviso aparece porque `isWallet` lo leen funciones reentrables: `verifyWallet` y el getter. Es reentrancia cross-function o de sólo lectura, y no es explotable:

- **Lectura durante la creación:** esas lecturas devuelven `false` / `NOT_WALLET`, que es la respuesta correcta.
- **Autorización:** ningún contrato del sistema autoriza con `isWallet`; el Guard usa la marca transitoria `isCreating`.
- **Reentradas:** la única reentrada esperada durante la creación es `initializeSafe` → `isCreating` (view).
- **Código que corre durante la creación:**
  - la SafeProxyFactory, el singleton SafeL2 y el `proxyCreationCode` están verificados por codehash en `validateConfig`;
  - `SafeBootstrap`, el `SecurityGuard` y el `DenyAllModuleGuard` (su `supportsInterface` corre dentro de `setGuard`/`setModuleGuard`) se verifican on-chain por cableado y, además, por codehash y runtime en `VerifyDeployment`.

## Hallazgos Low suprimidos

| Detector | Ubicación | Justificación |
|---|---|---|
| `missing-zero-check` | `SecurityGuard` constructor (`predecessor`) | `address(0)` es válido: el primer Guard (V1) no tiene predecesor ([C-GRD-17]). |
| `reentrancy-benign` | `SwapExecutorV3.swap` (limpieza del transient después del `swap` del pool) | Es la limpieza de `_payer`, `_tokenIn` y `_amountIn`. El transient además se borra al final de la transacción. |

## Hallazgos Low e Informational que se mantienen visibles

No fallan el gate y se revisan en cada auditoría.

| Detector | Severidad | Dónde | Comentario |
|---|---|---|---|
| `timestamp` (×10) | Low | `DestinationWhitelist`, `PolicyRegistry`, `RotationTimelock`, `SecurityGuard`, `SwapExecutorV3` | Ver [Detalle de `timestamp`](#detalle-de-timestamp). |
| `assembly` (×8) | Informational | `CallDecoder`, `SafeSignatureParser`, `SecurityGuard` (`_tload`, `_tstore`, `_tryGuardSlot`), `WalletFactory` | Lectura de firmas con el layout de Safe, `mcopy` de argumentos, transient storage (`tload`/`tstore`) y la lectura acotada del slot de guard (`staticcall` con tope de gas y copia de 96 bytes). Todos los bloques son `memory-safe` y tienen tests propios. |
| `cyclomatic-complexity` (×2) | Informational | `SecurityGuard._evaluate`, `RotationTimelock.propose` | Clasificación exhaustiva por reglas del spec. Cada rama está cubierta por tests unitarios y de integración (cobertura de ramas 100 % en `src/`). |
| `naming-convention` (×47) | Informational | 32 inmutables públicos en mayúsculas (`ADMIN`, `GUARD`, `POLICY_REGISTRY`…) y 15 funciones de interfaz | Convención del proyecto, igual que en Safe y OpenZeppelin. De las 15 funciones, 12 son getters de inmutables, 2 de constantes (`DELAY`, `ACTIVATION_DELAY`) y una es `ISafe.VERSION()`, que impone la ABI de Safe. |

### Detalle de `timestamp`

De los 10 hallazgos, 7 son comparaciones de tiempo reales:

- `DestinationWhitelist.isWhitelisted` y `destinationInfo` (activación a 24 h).
- `PolicyRegistry.activateChange` (24 h).
- `RotationTimelock.markExecuted` y `executableProposal` (48 h).
- `SecurityGuard._classifySwap` y `SwapExecutorV3.swap` (deadline).

Los otros 3 (`RotationTimelock.propose`, `cancelWithSignature` y `activeProposal`) son el mismo taint de `Proposal` que en `incorrect-equality`.

Comparar contra `block.timestamp` es la semántica pedida, y en Base no es manipulable de forma relevante:

- **Timestamp de L2:** sigue la cadencia fija de bloques y la deriva del secuenciador respecto del origen L1 está acotada.
- **Riesgo real:** que el secuenciador censure o demore una cancelación de rotación o una baja de destino.
- **Mitigación:** la inclusión forzada desde L1 (depósito al portal). El protocolo exige incluirla dentro de la ventana de secuenciación: `seq_window_size = 3600` bloques de L1, unas 12 h, según la configuración de mainnet del repositorio oficial `base/base` (`crates/common/chains/src/config.rs`, commit `32fb57f` del 2026-10-16). Queda por debajo de los timelocks de 24 h (whitelist y registro) y 48 h (rotaciones y upgrade del Guard).

## Límites de la herramienta

**Transient storage en assembly.** Slither no modela como estado los `tload`/`tstore` hechos en assembly:

- `vars-and-auth` muestra que `_tstore`, `_clearCtx` y `_setCreating` "no escriben" nada.
- Sí ve las variables `transient` declaradas en Solidity, como las de `SwapExecutorV3`.

Por lo tanto, los detectores de reentrancia y de dependencia de datos no ven la pila de contexto del Guard ni la marca `isCreating` de la factory. Por ejemplo, no reportan la limpieza del contexto después de `markExecuted`, ni `_setCreating(safe, false)` después de la creación. Ambas son intencionales: la primera llamada es al timelock propio y la segunda es la marca que debe valer sólo durante la creación.

Que no haya hallazgos ahí **no es evidencia de seguridad**. Esas propiedades se prueban con tests:

- [invariants.md](invariants.md): A6, A7, A8 e `invariant_A6_sovereignNeverBlocked`;
- `SovereignNeverBlockedTest`, `GuardBranchesTest` y `WalletFactoryTest.test_isCreatingOnlyDuringCreation`.

## Historial

- **`shadowing-local` en `ISafe.getTransactionHash`:** el parámetro `nonce` sombreaba `nonce()`. Se corrigió renombrándolo a `_nonce`, como en la interfaz oficial de Safe.
- **`low-level-calls` en `SecurityGuard._tryGuardSlot`:** desapareció al reemplazar la `staticcall` de Solidity por una en assembly con tope de gas y copia acotada (revisión P07.MAN).
- **`SwapExecutorV3.swap`:** el bloque `slither-disable-start/end` que cubría toda la función se reemplazó por supresiones de una línea en las lecturas de saldo y en la limpieza del transient. El `missing-zero-check` de `tokenIn` se eliminó en el código: `_tokenIn` sale de los inmutables, y es equivalente porque `tokenOutFor` ya restringe el token. Los `reentrancy-balance` pasaron de 4 a 2 al calcular el límite de precio antes de la llamada.

## Revisión independiente (P07.MAN, 2026-10-17)

Un agente revisor con contexto nuevo corrió Slither en un worktree propio, también con `--show-ignored-findings` y con las supresiones neutralizadas, y revisó cada supresión contra el código.

- **Veredicto:** aprobado con observaciones. Ninguna supresión esconde algo explotable.
- **Objeción media (bloque de supresión amplio en `swap`):** resuelta en el código.
- **Objeciones bajas:**
  - el baseline de suprimidos en CI;
  - las justificaciones de `reentrancy-no-eth`, `reentrancy-balance`, `incorrect-equality`, `timestamp` y `naming-convention`;
  - la lectura acotada en `_tryGuardSlot`;
  - los límites de la herramienta.

Todas quedaron resueltas en el código o en este documento. El detalle está en §13 del planner.
