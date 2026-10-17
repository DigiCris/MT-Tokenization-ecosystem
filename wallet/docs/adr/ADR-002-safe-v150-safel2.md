# ADR-002 — Safe v1.5.0 con singleton SafeL2

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-002), §3.2, §6.10 ([C-BST-02]), §6.11 ([C-FAC-02], [C-FAC-03], [C-FAC-04], [C-FAC-05]); V9 §1, §16; prompt §3 (Safe y Factory), §6

## Contexto

V9 §1 define la wallet como una Safe con tres owners (U, R, S) y threshold 2-de-3, sin ERC-4337 ni paymaster en el modelo base: S transmite `execTransaction` y paga gas. V9 §16 exige fijar por versión la release de Safe, el singleton, la factory y los hashes de runtime bytecode. El prompt §6 pide usar las dependencias reales de Safe en el fork de Base.

Hechos verificados el 2026-10-16 (§3.2):

- La release estable más reciente de Safe Smart Account es **v1.5.0** (2025-07-03; tag `v1.5.0`, commit `dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be`). El repositorio oficial es `github.com/safe-fndn/safe-smart-account`; `main` tiene cambios no publicados.
- La configuración oficial de Safe para Base recomienda `recommendedMasterCopyVersion: "1.5.0"` con `l2: true`.
- v1.5.0 trae `IModuleGuard` (interfaceId `0x58401ed8`; `setModuleGuard` exige ERC-165, `GS301`), necesario para cerrar la ejecución por módulos que pide V9 §10.
- `setup(...)` ejecuta `setupModules(to, data)` por DELEGATECALL, y desde ese código se puede llamar `setGuard`/`setModuleGuard` (verificado en fork).
- `createProxyWithCallback` fue removida en 1.5.0; existen `createProxyWithNonce` y `createProxyWithNonceL2` (esta última emite además `ProxyCreationL2` con el initializer).

## Decisión

Se usa **Safe v1.5.0** con el singleton **SafeL2** y la `SafeProxyFactory` v1.5.0, desplegando cada Safe vía `createProxyWithNonceL2`. No se usa `SafeToL2Setup`, porque el producto sólo corre en Base.

Contratos fijados (deployment `canonical` en Base, codehash verificado en el bloque 52700000, §3.2):

| Contrato | Address | Codehash |
|---|---|---|
| SafeL2 (singleton usado) | `0xEdd160fEBBD92E350D4D398fb636302fccd67C7e` | `0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc` |
| SafeProxyFactory | `0x14F2982D601c9458F93bd70B218933A6f8165e7b` | `0x967dae4cda22b0c9ef7f31b010bdc1ceb0af9904b0c3dc060b5302e4c18a4529` |
| `keccak256(SafeProxyFactory.proxyCreationCode())` | — | `0x941b3e88811b2f33b8e26783c7407d2e978404581a21c9f07abf2cad9cb87e12` |
| Runtime codehash de todo `SafeProxy` de esta factory | — | `0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f` |

Contratos de v1.5.0 que **no** se usan: el singleton L1 `Safe` (`0xFf51A5898e281Db6DfC7855790607438dF2ca44b`), `MultiSendCallOnly` (`0xA83c336B20401Af773B6219BA5027174338D1836`, sólo referencia; no se usa en el camino asistido) y `CompatibilityFallbackHandler` (`0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4`; no se instala: fallback = 0).

Reglas derivadas:

- La dirección de cada Safe se deriva con la fórmula de la factory v1.5.0: `salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce))`, `initCode = proxyCreationCode ‖ uint256(uint160(singleton))`, `CREATE2` ([C-FAC-04]).
- El initializer es `setup([U, R, S], 2, SAFE_BOOTSTRAP, bootstrap(U, R, S), fallbackHandler = 0, paymentToken = 0, payment = 0, paymentReceiver = 0)` ([C-FAC-03]); `SafeBootstrap` instala Guard y module guard dentro del `setup` ([C-BST-02]).
- La `WalletFactory` verifica en su constructor el codehash del singleton y de la proxy factory, el hash de `proxyCreationCode` y `VERSION() == "1.5.0"` ([C-FAC-02]), y tras cada creación vuelve a verificar runtime codehash del proxy y singleton ([C-FAC-05]).
- La dependencia de contratos se fija con Soldeer por commit git de `safe-fndn/safe-smart-account` v1.5.0 (`dc437e8`) en `soldeer.lock` (P03.T02; sin submódulos, que exigirían `.gitmodules` en la raíz). Nunca se compila desde `main`.

## Alternativas consideradas

- **Safe v1.4.1:** descartada porque no tiene module guard (§4), y sin él no se puede cerrar la ejecución por módulos con `DenyAllModuleGuard`.
- **Compilar desde `main` del repositorio de Safe:** descartado, porque contiene cambios no publicados (§3.2).
- **Singleton L1 (`Safe`):** descartado a favor de SafeL2, que emite `SafeMultiSigTransaction` y permite indexar las transacciones soberanas (§3.2, §4).
- **`SafeToL2Setup`:** innecesario, porque el producto sólo se despliega en Base (§4).
- **ERC-4337 / paymaster:** fuera del modelo base por V9 §1.

## Consecuencias

- Se usa la versión que Safe recomienda para Base, y los eventos de SafeL2 permiten que el historial incluya las transacciones soberanas no originadas por el backend ([B-FIN-03]).
- El módulo guard de v1.5.0 habilita `DenyAllModuleGuard` ([C-MGD]); el DELEGATECALL de `setupModules` habilita la instalación atómica de Guard y module guard en `SafeBootstrap`.
- Hechos de v1.5.0 que el resto del diseño debe respetar (§3.2):
  - `checkSignatures(msg.sender, …)` corre **antes** de `guard.checkTransaction(…, msg.sender)`: el Guard clasifica sobre firmas ya validadas (ADR-003). Dentro del guard `nonce()` ya vale N+1, por lo que el hash se reconstruye con `nonce() - 1`.
  - Si la ejecución falla con `safeTxGas == 0 && gasPrice == 0`, la transacción completa revierte y el nonce de la Safe **no** se consume ([B-SM-04]).
  - No hay getters públicos para los slots de guard (`0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8`), module guard (`0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947`) y fallback handler (`0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5`): se leen con `getStorageAt(slot, 1)`.
  - Safe no exige low-s, acepta firmas de contrato (`v=0`), hashes aprobados (`v=1`) y eth_sign (`v>30`); los owners pueden ser contratos o EOAs delegadas por EIP-7702. Por eso el camino asistido restringe los tipos de firma (ADR-003).
  - La cancelación de un nonce es la SafeTx `{to: safe, value: 0, data: 0x}`; el Guard debe permitirla ([C-GRD-05]).
- En tests sobre el fork, algunas cuentas públicas de Anvil están delegadas vía EIP-7702 en Base mainnet: U, R, S y el deployer de tests se generan siempre con claves nuevas (§3.2, [C-SCR-03]).
- Adoptar una release posterior de Safe exige una `WalletFactory` nueva, que sólo afecta a las wallets nuevas: los contratos propios son inmutables (P26.T15).

## Verificación

- P03.T02 — `safe-smart-account` v1.5.0 (`dc437e8`) fijado en `soldeer.lock` y verificado con `script/verify-deps.sh` (checkout exacto en ese commit).
- P03.T03 — `test/fork/ExternalContracts.t.sol`: código y `extcodehash` iguales a la config, `VERSION()` del singleton y hash de `proxyCreationCode()`.
- P03.T04 — `scripts/verify-external` verifica los codehash en el bloque fijado (integrado como PF-15).
- P04.T01 — selectores de las interfaces mínimas comparados con la Safe real del fork.
- P04.T06 — `setModuleGuard(DenyAll)` aceptado por Safe 1.5.0 y `execTransactionFromModule` revierte.
- P05.T04 — `WalletFactory` usando `createProxyWithNonceL2` de la factory real.
- P07.T01.m — implementación de Safe incorrecta (otro singleton, versión o proxy factory).
- P12.T04 — dirección calculada en TypeScript igual a `WalletFactory.predictWalletAddress` en el fork.
- P18.T02 — cálculo propio de la dirección (initializer + CREATE2) y verificación propia en el frontend Wallet.
- Trazabilidad: RQ-12, RQ-24.
