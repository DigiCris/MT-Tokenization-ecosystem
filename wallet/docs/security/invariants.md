# Mapa de assertions → tests (contratos)

P07.T08. Cada assertion de seguridad de §9 del planner (A1–A17) está cubierta por tests de contratos en tres niveles. Todo corre sobre el fork de Base, con la Safe v1.5.0 real y los contratos externos del bloque fijado.

- **Integración:** `test/integration/*` y `test/fork/*`, de P05 y P06.
- **Suite adversarial:** `test/adversarial/*`, de P07.T01. Cada contrato demuestra que un ataque falla.
- **Invariantes:** `test/invariant/WalletInvariants.t.sol`, de P07.T02. Un handler ejecuta secuencias aleatorias de operaciones asistidas legítimas y abusivas, operaciones soberanas y avances de tiempo, y lleva contadores fantasma de cada ataque que tuviera éxito.

La suite adversarial y las invariantes corren en los dos modos de policy, `POLICY_MODE=restricted` (igual que producción) y `POLICY_MODE=bootstrap` (P07.T09). CI corre la suite completa en ambos modos. Las suites de integración fijan su propio modo.

A14 y A18–A21 dependen de componentes off-chain (backend, signer, frontends, integrity monitor) y se cubren en sus fases. Para A18, la parte on-chain ya está cubierta acá.

## Cobertura por assertion

| ID | Assertion | Adversarial (P07.T01) | Invariante (P07.T02) | Integración y fork |
|---|---|---|---|---|
| A1 | U sola nunca ejecuta una SafeTx asistida | `SingleKeyAttackTest` (`test_singleSignatureNeverReachesThreshold`, `test_sameKeyTwiceRejected`) | `invariant_A1_A2_A3_noSingleKeyOrForeignSender` | `AssistedPathTest.test_singleKeyCannotExecute` |
| A2 | R sola nunca ejecuta una SafeTx asistida | ídem A1 | ídem A1 | ídem A1 |
| A3 | S sola nunca alcanza el threshold | `SingleKeyAttackTest` (además `test_executorApprovedHashPlusOwnSignatureRejected` y `test_executorImplicitApprovalRejectedInAssisted`); `WrongExecutorAttackTest` | ídem A1 | `AssistedPathTest.test_executorApprovedHashSignatureRejected` |
| A4 | U+S sólo ejecuta lo que permiten policy y Guard | `AdminCallsAttackTest`, `PersistentAllowanceAttackTest`, `SwapAttacksTest`, `NonWhitelistedSendAttackTest` | `invariant_A4_A9_assistedTransfersOnlyToActiveWhitelist`, `invariant_A10_A15_noThirdPartyAuthority` | `AssistedPathTest` (`test_transferRules`, `test_approveOnlyToRegisteredExecutor`, `test_adminCallsToSafeForbidden`, `test_systemContractsForbidden`, `test_unknownOperationDeniedInRestricted`), `BootstrapModeTest` |
| A5 | R+S sólo recovery permitido o migración autorizada | `UnauthorizedMigrationAttackTest`, `WrongExecutorAttackTest.test_recoveryAndExecutorCannotActAsUser` | `invariant_A5_recoveryNeverTransfers` | `MigrationTest`, `RotationsTest.test_recoveryProposalScope` |
| A6 | U+R opera sin backend ni S y el Guard nunca bloquea el camino soberano | `SovereignNeverBlockedTest` (7 tests) | `invariant_A6_sovereignNeverBlocked` | `SovereignPathTest` (10 tests) |
| A7 | El Guard clasifica sólo con los signers del threshold validado | `MalformedSignaturesAttackTest` (6 tests, incluye firmas anexadas) | `invariant_A7_classificationUsesThresholdSigners` | `SafeSignatureParserDifferentialTest` (diferencial contra `checkNSignatures`, 10.000 runs en `ci`) |
| A8 | DELEGATECALL, módulos y fallback cerrados en el camino asistido | `DelegateCallAttackTest`, `ModuleAndFallbackAttackTest`, `GasAndRefundAttackTest` | `invariant_A8_structuralRestrictions` | `AssistedPathTest.test_structuralInvariants`, `SovereignPathTest.test_sovereignConfigChangesFailClosedUntilRestored`, `DenyAllModuleGuardForkTest` |
| A9 | La salida a un destino no autorizado falla aunque U esté comprometida | `NonWhitelistedSendAttackTest` (no whitelisteado, pendiente, de otra Safe y prohibidos) | `invariant_A4_A9_assistedTransfersOnlyToActiveWhitelist` (modelo propio con activación a 24 h) | `AssistedPathTest.test_transferRejectsNonWhitelistedAndPendingDestinations` |
| A10 | Approvals, permits y operator rights fallan por defecto | `PersistentAllowanceAttackTest` (cada selector de [C-DEC-03] contra USDC, USDT y un token cualquiera, y Permit2) | `invariant_A10_A15_noThirdPartyAuthority` | `CallDecoderTest` (P04), `AssistedPathTest.test_economicAuthorityAlwaysDenied` |
| A11 | Una Safe con configuración distinta de la de la factory no alcanza ACTIVE | `WrongImplementationAttackTest`, `FactoryInitializationAttackTest`, `RegistrationSpoofingAttackTest` | `invariant_A11_configurationIntact` (`verifyWallet` y roles == owners tras cualquier secuencia) | `WalletFactoryTest`, `SafeBootstrapTest` |
| A12 | Una firma no se reusa con otro nonce, otra Safe u otra cadena | `ReplayAttackTest` (otro nonce, nonce pasado o futuro, otra Safe, chainId 1 y 10) | `invariant_A12_A13_noReplay` | `AssistedPathTest.test_signaturesCannotBeReplayed` |
| A13 | Cancelar con nonce N invalida la SafeTx pendiente de N | `ReplayAttackTest.test_noOpCancelsPendingSafeTx` | `invariant_A12_A13_noReplay` | `AssistedPathTest.test_noOpCancelsPendingNonce` |
| A14 | Un único trust domain comprometido no entrega control completo | A4, A9, A10, A15 y A17 desde el lado on-chain | — | P23 y P27 (combinaciones de dominios comprometidos) |
| A15 | Ninguna allowance persistente a terceros; allowance 0 al executor tras el swap | `PersistentAllowanceAttackTest` (allowance residual inutilizable, revocable por R, 0 tras el swap) | `invariant_A10_A15_noThirdPartyAuthority` | `SwapExecutorV3Test.test_residualAllowanceNotUsableByThirdParties`, `SwapGuardIntegrationTest` |
| A16 | El swap sólo opera USDC↔USDT, pool canónico, recipient = Safe y minOut sobre el piso | `SwapAttacksTest` (token arbitrario, recipient arbitrario, calldata maliciosa, piso, deadline, executor falso) | `invariant_A16_swapScope` | `SwapExecutorV3Test`, `SwapGuardIntegrationTest`, `QuoteReferenceTest` |
| A17 | Rotaciones asistidas sólo tras 48 h y sin cancelación | `RotationBypassAttackTest`, `GuardUpgradeAttackTest` | `invariant_A17_rotationsOnlyAfterDelay` | `RotationsTest`, `RotationTimelockTest`, `GuardUpgradeTest` |
| A18 | El backend solo no altera la whitelist | `NonWhitelistedSendAttackTest.test_thirdPartyCannotWriteTheSafeWhitelist` (parte on-chain) | — | P14, P23 y P27 |

## Garantías propias de las invariantes

Además de los contadores de violación, `WalletInvariantsTest` exige después de cada llamada:

- **Conservación de fondos:**
  - los saldos de USDC y USDT de la Safe son exactamente los del modelo (transferencias y swaps exitosos);
  - el atacante sólo tiene lo que U+R le enviaron por camino soberano.
- **Executor sin fondos:** nunca retiene USDC ni USDT.
- **Configuración intacta:**
  - `verifyWallet` de la factory da OK;
  - los roles del Guard coinciden con los owners, también después de rotaciones asistidas y soberanas.

`test_handlerExercisesTheSystem` demuestra que las invariantes no son vacuas: una secuencia fija del handler produce operaciones exitosas de cada tipo (transferencia a destino activo, swap, rotación madura y operaciones soberanas) y cada ataque falla.

## Parámetros

| Suite | `default` | `ci` |
|---|---|---|
| Invariantes | 16 runs × profundidad 32 | 32 runs × profundidad 50, por modo de policy |
| Fuzz de contratos | 256 runs | 10.000 runs; 500 en el fuzz de swaps sobre el fork |

Cada llamada del handler son varias SafeTx reales sobre el fork, alrededor de 0,1 s de CPU, y eso fija los runs de las invariantes.

## Cómo correr

```bash
cd wallet/contracts
POLICY_MODE=restricted forge test --profile ci --match-path 'test/adversarial/*'
POLICY_MODE=bootstrap  forge test --profile ci --match-path 'test/invariant/*'
```
