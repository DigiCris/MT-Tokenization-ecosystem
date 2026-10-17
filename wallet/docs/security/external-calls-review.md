# Revisión manual de llamadas externas de los contratos

Revisión manual de P05.SEC (cada llamada externa del `SecurityGuard`) y P06.SEC (rutas de `transferFrom` del `SwapExecutorV3`), con un resumen de las llamadas de los demás contratos del sistema para la auditoría (P27). Complementa a [slither-triage.md](slither-triage.md) y al [threat model](../THREAT_MODEL.md).

- **Fecha:** 2026-10-17.
- **Código:** `contracts/src` de P05/P06, Safe v1.5.0 y contratos externos de `config/chains/base-mainnet.json` al bloque de fork.
- **Responsable:** agente de ejecución del planner.

## Criterios

Para cada llamada se registra:

- **Destino:** a quién se llama.
- **Cómo se fija el destino:** inmutable del constructor, valor verificado en la configuración o dirección habilitada por el `PolicyRegistry`.
- **Tipo:** `STATICCALL` (función `view`) o `CALL` con efectos.
- **Camino:** desde dónde se alcanza la llamada:
  - el camino soberano (U+R), que nunca puede revertir;
  - el camino asistido (U+S o R+S), que debe fallar cerrado;
  - las vistas;
  - el registro.
- **Qué pasa si el destino revierte o miente.**

Reglas generales que valen para todas las llamadas:

- **Efectos antes de interacciones.** Ninguna función del Guard escribe storage después de una llamada externa con efectos.
- **Una única llamada con efectos fuera del constructor.** Es `RotationTimelock.markExecuted` en `checkAfterExecution`. Va después de actualizar roles y emitir eventos, y el destino es el timelock que el propio Guard creó.
- **Sin llamadas a direcciones elegidas por la transacción.** Todo destino es un inmutable, la Safe que llama (`msg.sender`), o un token o executor habilitado por el `PolicyRegistry` (timelock de 24 h más guardianes en `RESTRICTED`).
- **Sin envío de ETH.** Ninguna llamada transfiere ETH ni usa `delegatecall`.

## `SecurityGuard`

### Constructor

| Llamada | Destino | Tipo | Observaciones |
|---|---|---|---|
| `new RotationTimelock(address(this))` | contrato nuevo | `CREATE` | Código propio. El constructor del timelock no llama afuera. La dirección resultante es el inmutable `ROTATION_TIMELOCK`, y `VerifyDeployment` la verifica como el primer `CREATE` del Guard. |

### `initializeSafe` (registro, [C-GRD-01])

La Safe llama a `initializeSafe` durante su `setup`, vía `SafeBootstrap` por `DELEGATECALL`.

| Llamada | Destino | Tipo | Observaciones |
|---|---|---|---|
| `getStorageAt(0, 1)` (singleton) | la Safe que se registra (`msg.sender`) | `STATICCALL` | Se verifica antes que el codehash sea el del `SafeProxy` canónico. Un singleton hostil podría mentir sobre el slot 0, pero el control decisivo es el siguiente. |
| `IWalletFactory.isCreating(safe)` | `WALLET_FACTORY` (inmutable, dirección predicha) | `STATICCALL` | Marca transitoria (EIP-1153) que sólo pone `createWallet` para la dirección CREATE2 del initializer real con `SAFE_SINGLETON`. Esa dirección sólo puede contener un proxy con el singleton real, así que una Safe ajena no puede registrarse. |
| `getOwners`, `getThreshold`, `getStorageAt` (guard, module guard, fallback), `getModulesPaginated` | la misma Safe | `STATICCALL` | Lecturas de la Safe recién creada, ya garantizada por `isCreating`. Todas las verificaciones van antes de escribir `_roles` y no hay llamadas con efectos, así que no hay reentrancia posible. |

### `checkTransaction` (antes de ejecutar)

| Llamada | Destino | Tipo | Camino | Si falla o miente |
|---|---|---|---|---|
| `_importRoles`: `safe.codehash`, `_tryGuardSlot` (`staticcall` de bajo nivel a `getStorageAt`) y `try PREDECESSOR.rolesOf` | la Safe que llama y `PREDECESSOR` (inmutable; `0` en V1) | `STATICCALL` | sólo si la Safe no está registrada | Nunca revierte. Ver la [nota sobre `_tryGuardSlot`](#nota-sobre-_tryguardslot). Sin roles → `UnregisteredSafe`, por especificación ([C-GRD-03] paso 1): una Safe ajena que instala este Guard queda bloqueada, porque el Guard sólo se instala en `SafeBootstrap`. |
| `nonce()` y `getTransactionHash(..., nonce - 1)` | la Safe que llama | `STATICCALL` | los dos | Es la propia Safe la que calcula el hash que acaba de validar en `checkNSignatures`. |
| `getThreshold()` | la Safe que llama | `STATICCALL` | los dos | |
| `ecrecover` (precompile `0x01`) | precompile | `STATICCALL` | los dos | `SafeSignatureParser` refleja la lectura de `signatureSplit` de Safe; test diferencial contra `checkNSignatures` real. |
| `IPolicyRegistry`: `isOpAllowed`, `isRestricted`, `isSupportedToken`, `tokenDecimals`, `isSwapExecutor`, `isMigrationAuthorized`, `successorGuardOf`, `successorModuleGuardOf` | `POLICY_REGISTRY` (inmutable) | `STATICCALL` | asistido | Código propio, sin dependencias externas. |
| `IDestinationWhitelist.isWhitelisted` | `DESTINATION_WHITELIST` (inmutable) | `STATICCALL` | asistido | Código propio. |
| `IRotationTimelock.executableProposal` | `ROTATION_TIMELOCK` (inmutable) | `STATICCALL` | asistido | Código propio. |
| `IERC20.balanceOf(safe)` (approve y swap) | token soportado por el registro (USDC y USDT en V1) | `STATICCALL` | asistido | El token ya pasó `isSupportedToken`. USDC es un proxy upgradeable de Circle, con pausa y blacklist: es un supuesto de confianza documentado en el threat model, y el codehash de la implementación está fijado en la configuración y lo verifican `VerifyDeployment` y `verify-external`. |
| `ISwapExecutor.tokenOutFor(tokenIn)` | executor registrado en el registro | `STATICCALL` | asistido | Sólo se llama si `isSwapExecutor(executor)`. Se exige que el `tokenOut` devuelto también esté soportado y tenga los mismos decimales. Un executor que mintiera falla igual en las post-condiciones de saldo. |
| `IWalletFactory.SAFE_BOOTSTRAP()` (`try`/`catch`) | `WALLET_FACTORY` | `STATICCALL` | asistido (destinos prohibidos) | Si la factory no tiene código o no tiene el getter, se toma `address(0)`: sólo agrega un destino a la lista de prohibidos. |
| `rolesOf(dest)` para migración (`_effectiveRoles` → `_predecessorRoles`) | `dest` y `PREDECESSOR` | `STATICCALL` | asistido, con autorización de migración del registro | Nunca revierte. Un `dest` que no es una Safe del sistema queda sin roles y la migración se rechaza. |

### `checkAfterExecution` (después de ejecutar)

| Llamada | Destino | Tipo | Camino | Observaciones |
|---|---|---|---|---|
| ninguna | — | — | soberano | Sin llamadas externas. Si hubo un `swapOwner` directo exitoso, sólo actualiza `_roles` (`RolesSynced`) y limpia el contexto. Nunca revierte. |
| `IERC20.balanceOf` y `IERC20.allowance(safe, executor)` | `tokenIn` y `tokenOut` del contexto | `STATICCALL` | asistido (SWAP) | Post-condiciones de [C-GRD-09]. Un token que mintiera sólo podría hacer fallar la transacción. |
| `IRotationTimelock.markExecuted(id)` | `ROTATION_TIMELOCK` | **`CALL`** | asistido (ROTATION_EXECUTE y GUARD_UPGRADE) | Única llamada con efectos. Va después de `_setKey` y del evento. El timelock es código propio, sólo acepta llamadas del Guard y no llama afuera, así que no hay reentrancia. |
| `getStorageAt` (fallback, guard, module guard), `getModulesPaginated`, `getThreshold`, `getOwners` y `successorModuleGuardOf` | la Safe y `POLICY_REGISTRY` | `STATICCALL` | asistido | Estado posterior intacto ([C-GRD-04] (3)). Cualquier diferencia → `SafeConfigurationAltered` (falla cerrada). |

### Vistas y `updateRoles`

| Llamada | Destino | Tipo | Observaciones |
|---|---|---|---|
| `rolesOf`, `roleOf`, `isRegistered` | `_effectiveRoles` (ver arriba) | `STATICCALL` | Nunca revierten, ni siquiera con un `SafeProxy` hostil. Hay un test para cada caso. |
| `evaluateAssisted` → `this.classifyAssisted` | el propio Guard | `STATICCALL` | `try`/`catch`: sólo se devuelve el selector del error. |
| `updateRoles`: `isOwner` ×3 | la Safe registrada (`msg.sender`) | `STATICCALL` | En la práctica sólo es alcanzable por camino soberano: en el asistido, [C-GRD-13] bloquea cualquier llamada al Guard. |

### Nota sobre `_tryGuardSlot`

Antes de esta revisión, `_predecessorRoles` leía el slot de guard con `getStorageAt` sin `try`/`catch`. Con un `SafeProxy` cuyo singleton no es una Safe, la lectura revertía, aunque la función está documentada como "nunca revierte".

Ahora la lectura es una `staticcall` de bajo nivel que exige un retorno de exactamente 96 bytes con offset 32 y longitud 32, y lo decodifica como tipos estáticos. Así no puede revertir ni con datos malformados, que el `try`/`catch` de Solidity no captura. El test es `GuardUpgradeTest.test_successorReadsForeignProxiesWithoutReverting`, con cuatro singletons: uno que revierte, uno con retorno corto, uno con offset inválido y uno con longitud inválida.

Ningún camino soberano de una Safe sana dependía de esto: sólo afectaba a vistas, a la importación de una Safe con singleton propio y a migraciones asistidas. Igual se corrigió para que el código cumpla lo que documenta.

## `SwapExecutorV3` (P06.SEC: rutas de `transferFrom`)

El único `transferFrom` de todo `contracts/src` es `IERC20(tokenIn).safeTransferFrom(payer, POOL, delta)` en `uniswapV3SwapCallback`. El `payer` no puede ser distinto de quien inició el swap:

1. `payer` es transient storage que sólo escribe `swap()`, con `_payer = msg.sender`.
2. `swap()` es `nonReentrant` (transient) y borra `_payer`, `_tokenIn` y `_amountIn` antes de terminar.
3. El callback revierte con `UnauthorizedCallback` si `msg.sender != POOL` (inmutable, verificado con `factory.getPool` en el constructor) o si no hay un swap en curso (`payer == 0`).
4. El callback revierte con `UnexpectedDelta` si el delta pedido por el pool no es exactamente `amountIn`, así que nunca paga un monto distinto.
5. No existe otra función que mueva tokens, y el executor no guarda saldos: las pruebas verifican saldo 0 después de cada swap.

Consecuencia (A15): una allowance residual de la Safe hacia el executor no la puede usar un tercero, porque quien llama `swap` paga con su propia allowance. La prueba es `SwapExecutorV3Test.test_residualAllowanceNotUsableByThirdParties`, más `test_callbackOnlyFromPoolDuringSwap`, `test_reentrancyAndWrongDeltaRejected`, `test_amountAboveLiquidityReverts` y `test_inconsistentPoolResultsRejected`.

Otras llamadas del executor:

| Llamada | Destino | Tipo | Observaciones |
|---|---|---|---|
| `getPool`, `token0`, `token1`, `fee`, `decimals` | factory v3, pool, USDC y USDT | `STATICCALL` | Sólo en el constructor. |
| `balanceOf(msg.sender)` antes y después | `tokenIn` y `tokenOut` | `STATICCALL` | Débito exacto y crédito mínimo. |
| `POOL.swap(msg.sender, ...)` | pool canónico | `CALL` | El recipient es siempre `msg.sender`: por construcción, imposible enviar a terceros. |

## Otros contratos del sistema (resumen)

| Contrato | Llamadas externas | Observaciones |
|---|---|---|
| `RotationTimelock` | `GUARD.isRegistered`, `GUARD.roleOf`, `GUARD.POLICY_REGISTRY` y `successorGuardOf`/`successorModuleGuardOf`; `getStorageAt` de la Safe que propone; `ECDSA.recover` | Todas son `STATICCALL`. `GUARD` es inmutable. Firmas de cancelación EIP-712 de 65 bytes con low-s. |
| `SafeBootstrap` | `setGuard` y `setModuleGuard` sobre sí misma (corre en el contexto de la Safe por `DELEGATECALL`) y `SECURITY_GUARD.initializeSafe` | Revierte si no se ejecuta por `DELEGATECALL` (`SELF`). |
| `WalletFactory` | `createProxyWithNonceL2` (`CALL` a la SafeProxyFactory, verificada por codehash); lecturas de la Safe creada y del Guard; `validateConfig` lee codehashes, `proxyCreationCode`, `VERSION` y el cableado | `createWallet` es `nonReentrant`. `isWallet` se marca después de verificar la Safe en la misma transacción ([C-FAC-05]). |
| `PolicyRegistry`, `DestinationWhitelist`, `DenyAllModuleGuard` | ninguna | Sólo estado propio. |

## Resultado

- Ninguna llamada externa del Guard puede hacer revertir el camino soberano de una Safe registrada sana.
- Las que alcanzan direcciones no fijadas (`dest` de una migración, Safes hostiles en vistas) nunca revierten.
- La única llamada con efectos es al timelock propio, después de los efectos.
- No existe una ruta de `transferFrom` con payer distinto de `msg.sender`.

Hallazgo corregido en esta revisión: lectura de `getStorageAt` sin protección en `_predecessorRoles`.
