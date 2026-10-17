# ADR-003 — SecurityGuard inmutable y compartido

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-003), §3.2, §6 ([C-GEN]), §6.1, §6.2 ([C-PAR-01], [C-PAR-02]), §6.3 ([C-DEC-03]), §6.4 ([C-GRD-01] a [C-GRD-17]), §9.2 (A1, A2, A3, A7, A8); V9 §9, §10, §19, §20; prompt §3 (SecurityGuard), §28

## Contexto

V9 §9 exige un `SecurityGuard` de código inmutable que mantenga on-chain la identidad del executor S. Safe valida threshold y firmas; el Guard clasifica el camino usando **exclusivamente** los signers que corresponden a las firmas de threshold realmente validadas por Safe, nunca bytes anexados. El camino asistido es `msg.sender = S` con signers validados `{S, X}` y X distinto de S, sujeto a policy y Guard, con las invariantes `operation = CALL`, `safeTxGas = baseGas = gasPrice = 0` y `gasToken = refundReceiver = address(0)`. V9 §10 cierra módulos, fallback y DELEGATECALL en el camino asistido, y V9 §19 establece que S es el único owner con rol especial.

Hechos de Safe v1.5.0 que condicionan el diseño (§3.2, ADR-002): `checkSignatures` corre antes que `checkTransaction` y este recibe `msgSender`; Safe acepta firmas de contrato (`v=0`, EIP-1271 vía STATICCALL), hashes aprobados (`v=1`), eth_sign (`v>30`) y ECDSA; no exige low-s; los owners pueden ser contratos o EOAs delegadas por EIP-7702; dentro del guard `nonce()` ya vale N+1.

## Decisión

`SecurityGuard` **inmutable, sin owner y compartido** por todas las Safes, con registro de roles por Safe (`U`, `R`, `S`) al que sólo pueden acceder Safes creadas por la `WalletFactory`. El camino soberano nunca revierte (ADR-004). El Guard clasifica el camino con los signers de las primeras `threshold` firmas —las que Safe ya validó, porque `checkSignatures` corre antes del guard— usando un parser espejo del de Safe; camino asistido ⇔ S ∈ signers; en el asistido exige `msgSender == S`, exactamente 2 firmas ECDSA (`v ∈ {27,28}`) y X ∈ {U, R}.

Detalle ([C-GRD], [C-PAR]):

- **Inmutables:** `POLICY_REGISTRY`, `DESTINATION_WHITELIST`, `DENY_ALL_MODULE_GUARD`, `WALLET_FACTORY` (dirección predicha), `SAFE_L2_SINGLETON`, `SAFE_PROXY_RUNTIME_CODEHASH`, `ROTATION_TIMELOCK` (creado en el constructor con `new RotationTimelock(address(this))`) y `MAX_SWAP_SLIPPAGE_BPS = 50`. Storage: `roles[safe] = {userKey, recoveryKey, executor, initialized, version}`. La dirección de `WalletFactory` se predice (`CREATE` desde el deployer con nonce conocido, `vm.computeCreateAddress`) y `DeployCore` descarta el deploy completo si la real no coincide (§6.1).
- **Registro anti-suplantación** ([C-GRD-01]): `initializeSafe(U, R, S)` lo llama la propia Safe durante `setup` vía `SafeBootstrap` y exige `msg.sender.codehash == SAFE_PROXY_RUNTIME_CODEHASH`, singleton (slot 0) `== SAFE_L2_SINGLETON` e `IWalletFactory(WALLET_FACTORY).isCreating(msg.sender) == true` (marca transitoria de la factory); además: no inicializada; U, R, S distintas, ≠ 0, ≠ sentinel `0x1`, ≠ Safe; owners == {U, R, S}; threshold == 2; slot de guard == este contrato; module guard == `DENY_ALL_MODULE_GUARD`; fallback == 0; sin módulos. Emite `SafeRegistered(safe, U, R, S)`.
- **Clasificación** ([C-GRD-03], [C-PAR-01]): `txHash = getTransactionHash(…, nonce() - 1)` y `signers = SafeSignatureParser.thresholdSigners(txHash, signatures, getThreshold())`, que recorre sólo las primeras `threshold` firmas estáticas de 65 bytes con el mismo layout y la misma lectura de `v` que `signatureSplit` de Safe 1.5.0, revierte si `signatures.length < threshold * 65` o si algún signer es `address(0)`, y nunca lee bytes anexados. Si `executor ∉ signers`, el camino es SOVEREIGN.
- **Camino ASSISTED:** `msgSender == executor` (`WrongExecutor`); threshold == 2 y exactamente 2 signers; ambas firmas ECDSA (`UnsupportedSignatureType`); X = signer ≠ S con rol ∈ {U, R} (`UnknownCosigner`); `operation == CALL` (`DelegateCallForbidden`); `safeTxGas == baseGas == gasPrice == 0`; `gasToken == refundReceiver == address(0)`; `value == 0` (V1 no mueve ETH en camino asistido); estado previo intacto (fallback 0, module guard DenyAll, sin módulos, 3 owners, threshold 2): si U+R alteraron la estructura, el camino asistido queda deshabilitado (fail-closed) hasta que la restauren o actualicen roles con [C-GRD-14]. Se exige además que no haya otra ejecución de esa Safe en curso (`depth == 1`).
- **Operaciones tipificadas:** NOOP [C-GRD-05], TRANSFER [C-GRD-06], APPROVE [C-GRD-07], autoridades económicas denegadas en ambos modos [C-GRD-08] según [C-DEC-03], SWAP [C-GRD-09], WHITELIST [C-GRD-10], ROTATION_PROPOSE/CANCEL [C-GRD-11], ROTATION_EXECUTE [C-GRD-12] y GUARD_UPGRADE [C-GRD-17]; toda otra llamada a la propia Safe o a contratos del sistema → `AdminCallForbidden` [C-GRD-13]. Luego `POLICY_REGISTRY.isOpAllowed(opType, rol)` (ADR-005).
- **Post-check** ([C-GRD-04]): en ASSISTED, en orden: `success == true`; post-checks y efectos del opType; estado posterior intacto (fallback 0, module guard DenyAll, sin módulos, guard == este contrato, threshold 2, owners == roles ya actualizados); limpieza del contexto. El contexto por Safe vive en transient storage (EIP-1153), apilado por profundidad (`depth[safe]`).
- **Vistas** ([C-GRD-02]): `rolesOf(safe)`, `isRegistered(safe)` y `evaluateAssisted(safe, role, to, value, data)` (misma lógica sin efectos; backend y signer la usan como pre-check). `supportsInterface`: `0xe6d7a83a` (ITransactionGuard) y `0x01ffc9a7` (IERC165) ([C-GRD-15]).
- **Regla de tamaño** ([C-GRD-16]): si el runtime supera 24.576 bytes (`forge build --sizes` en P05), la evaluación se mueve a un contrato `AssistedPolicyEngine` inmutable y sin estado, llamado por `staticcall`, con dirección y codehash fijados en el Guard; la decisión se documenta en este ADR (P05.T02).

## Alternativas consideradas

- **Aceptar firmas `v=0`, `v=1` o `v>30` en el camino asistido:** descartado; se excluyen para eliminar la confusión de firmas (EIP-1271, EIP-7702), porque con `v=0` decide el código del owner (§3.2, §4).
- **Clasificar con todo el blob de firmas o con bytes anexados:** descartado por V9 §9; el parser lee sólo las primeras `threshold` firmas, igual que Safe ([C-PAR-01]).
- **Guard con owner, proxy o upgradeable:** descartado por V9 §9 (código inmutable) y por las reglas generales de contratos: sin proxies ni upgradeability y sin owner salvo `PolicyRegistry` ([C-GEN]). La vía de corrección para Safes existentes es ADR-029.
- **Registro abierto a cualquier contrato que se presente como Safe:** descartado; un contrato que imite las vistas de una Safe o una Safe creada directamente con `SafeProxyFactory` + `SafeBootstrap` no puede registrarse ([C-GRD-01], P07.T01.p).

## Consecuencias

- A1, A2, A3, A7 y A8 se garantizan on-chain: ni U, ni R, ni S solas ejecutan una SafeTx asistida, la clasificación no se puede engañar con bytes anexados y DELEGATECALL, módulos y fallback quedan cerrados en el camino asistido.
- Una R externa debe ser una EOA con firma ECDSA: no se aceptan smart-contract wallets como R en V1 ([F-KEY-09]).
- Safe no exige low-s, por lo que backend y signer verifican firma ECDSA estricta (65 bytes, low-s, `v ∈ {27,28}`) antes de co-firmar ([B-Q-02] paso 4).
- Backend y signer usan `evaluateAssisted` como pre-check sin efectos antes de pedir la firma S ([B-Q-02] paso 8).
- La inmutabilidad impide corregir un bug en el lugar: la corrección para Safes existentes exige la vía de upgrade con timelock de ADR-029.
- Después de P07 los contratos quedan congelados para V1: cualquier cambio posterior obliga a re-ejecutar P07 completo.
- Si el Guard excede 24.576 bytes, se agrega `AssistedPolicyEngine` como contrato inmutable adicional, con su dirección y codehash fijados.

## Verificación

- P04.T02 — `SafeSignatureParser` y test diferencial contra `checkNSignatures` de la Safe real del fork, con ≥ 10.000 runs en el perfil `ci` ([C-PAR-02]).
- P04.T03 — `CallDecoder` con longitudes exactas y recorrido de cada selector de autoridad de [C-DEC-03].
- P05.T02 — `SecurityGuard` completo y `forge build --sizes` (regla de [C-GRD-16]).
- P05.T06 — integración en fork: `msg.sender ≠ S` y firma S tipo `v=1` revierten en asistido; registro imposible para Safes ajenas a la factory; fail-closed tras cambios soberanos.
- P07.T01.b, P07.T01.c, P07.T01.d, P07.T01.e, P07.T01.f, P07.T01.g, P07.T01.n y P07.T01.p — DELEGATECALL, módulos y fallback, parámetros de gas/refund/value, executor y combinaciones de signers, U/R/S solas, firmas malformadas, cambios administrativos asistidos y suplantación de registro.
- P07.T02 — invariantes A1–A17 con handlers (incluye "ninguna tx asistida exitosa tuvo gas params, gasToken, refundReceiver o value ≠ 0").
- P07.T03 — cobertura ≥ 95 % líneas y ≥ 90 % ramas en `src/`.
- P07.T04 — Slither 0.11.6 con triage documentado.
- P07.T09 — suites en modos RESTRICTED y BOOTSTRAP.
- P05.SEC y P07.SEC — Slither, revisión de cada llamada externa del Guard y Semgrep.
- P27.T02.b y P27.T02.f — auditoría de bypass del Guard y de confusión de firmas.
- Trazabilidad: RQ-07, RQ-09, RQ-10.
