# Triage de Slither

Slither 0.11.6 sobre `contracts/src` con `contracts/slither.config.json` (excluye `dependencies/`, `test/` y `script/`). El gate de CI es `slither . --config-file slither.config.json --fail-medium`, que falla ante cualquier hallazgo Medium o High sin triage (en 0.11.6 `--fail-medium` ya cubre High y no se puede combinar con `--fail-high`).

Cada supresión va en el código, junto a la línea o el bloque, con su justificación (`// slither-disable-next-line <detector>` o `// slither-disable-start/end <detector>`). Este documento las consolida para P04.SEC, P07 y la auditoría (P27); se amplía con cada fase que agrega contratos.

## P04: librerías, PolicyRegistry, DestinationWhitelist y DenyAllModuleGuard

Sin hallazgos High ni Medium y sin supresiones. Hallazgos Low e Informational que se mantienen visibles (no fallan el gate):

| Detector | Severidad | Dónde | Comentario |
|---|---|---|---|
| `timestamp` | Low | `DestinationWhitelist`, `PolicyRegistry` | Activaciones a las 24 h: comparar contra `block.timestamp` es la semántica pedida; los validadores sólo lo desplazan segundos frente a demoras de horas. |
| `assembly` | Informational | `CallDecoder`, `SafeSignatureParser` | Lectura de firmas con el layout de Safe y `mcopy` de argumentos; bloques `memory-safe` con tests propios (diferencial contra `SignatureDecoder` de Safe 1.5.0). |
| `naming-convention` | Informational | getters de inmutables en mayúsculas en las interfaces y en `PolicyRegistry` (`ADMIN()`, `ACTIVATION_DELAY()`…) | Convención del proyecto, igual que Safe y OpenZeppelin. |

`shadowing-local` en `ISafe.getTransactionHash` (el parámetro `nonce` sombreaba `nonce()`) se corrigió renombrando el parámetro a `_nonce`, como en la interfaz oficial de Safe.
