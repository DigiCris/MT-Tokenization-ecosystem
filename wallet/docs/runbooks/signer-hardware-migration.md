# Runbook: migración del signer S a un HSM físico

Hardening futuro y opcional de ADR-014: pasar las claves S de `SelfHostedSoftwareSignerProvider` (keystores V3 en el
volumen del shard) a un HSM físico propio (PKCS#11 o YubiHSM) con claves secp256k1 **no exportables**. En V1 no se
ejecuta: quedan listas la interfaz (`backend/signer/src/providers/HardwareSignerProvider.ts`), la adaptación de firmas
del HSM al formato de Ethereum y la suite de contrato común (`backend/signer/test/providers/contract-suite.test.ts`).

La migración **nunca exporta ni importa claves**: cada Safe rota su S hacia una clave nueva creada dentro del HSM,
por el `RotationTimelock` y con la firma del usuario, igual que cualquier rotación de S ([B-SIG-08], [C-GRD-11/12]).

## Requisitos previos

1. **HSM con secp256k1 no exportable.** YubiHSM 2 (algoritmo `ecp256k1`) o un HSM PKCS#11 con `CKM_ECDSA` sobre la
   curva secp256k1 (OID `1.3.132.0.10`), atributos `CKA_SENSITIVE=true` y `CKA_EXTRACTABLE=false`.
2. **Implementación de `HsmSession`** para ese HSM (generar, leer la clave pública y firmar un digest de 32 bytes).
   `HardwareSignerProvider` ya normaliza `s` a la mitad baja y calcula `v`; el HSM puede devolver `r ‖ s` crudo.
3. **Suite de contrato en verde contra el HSM real:** agregar el provider a `test/providers/contract-suite.test.ts`
   y correr `pnpm --dir backend/signer vitest run test/providers/contract-suite.test.ts`. Sin esto no se migra.
4. **Shard nuevo para el HSM** (por ejemplo `hsm-1`) con su identidad mTLS, su DB lógica en `signer-postgres` y la
   clave de atestación del entorno (la misma pública que embeben los frontends). Se inicializa con
   `pnpm --dir backend/signer shard:create` y se agrega a `SIGNER_SHARDS` del backend **sin** marcarlo para wallets
   nuevas hasta terminar la validación.
5. **Gas:** la cuenta gas tank recarga la S nueva cuando pasa a ser executor; confirmar saldo y tope diario.

## Procedimiento por Safe

1. **Crear la S nueva en el HSM:** el backend pide `POST /v1/keys` con `{walletId, reason: "ROTATION"}` al shard
   `hsm-1`. La respuesta trae la `SignerKeyAttestation` de la clave nueva.
2. **Proponer la rotación:** el backend prepara la `ROTATION_PROPOSE` (tipo S, `old` = S vigente, `new` = S del HSM)
   y U la firma en la Wallet. El shard de la S vigente la co-firma sólo si la atestación es válida para esa wallet y
   esa clave (rotación de S únicamente hacia claves creadas por un signer).
3. **Esperar el timelock de 48 h.** El usuario recibe el email y la notificación; U o R pueden cancelar con su firma
   individual (`POST /rotations/{id}/cancel`). Si se cancela, la clave del HSM queda sin uso y se retira.
4. **Ejecutar:** `ROTATION_EXECUTE` (`swapOwner(prev, S vieja, S nueva)`) firmada por U (o R) y co-firmada por la S
   **vieja**. El Guard actualiza el rol (`RoleRotated`) y la S nueva rige desde la siguiente transacción.
5. **Registrar el cambio en el backend:** `signer_keys` de la wallet pasa a la clave del HSM (`shard_id = hsm-1`,
   `ACTIVE`); la vieja queda `RETIRED` y el shard de origen la retira con `POST /v1/keys/retire` (verifica on-chain
   que ya no es executor). Su keystore se destruye a los 30 días si no hay operaciones pendientes
   (`pnpm --dir backend/signer shard:destroy-retired`).
6. **Verificar:** `SecurityGuard.rolesOf(safe).executor` es la clave del HSM y la siguiente operación del usuario la
   co-firma el shard `hsm-1` (`GET /v1/health` del shard y logs `SafeTx co-firmada por S`).

## Plan por lotes

- Empezar por Safes internas o de prueba; después lotes chicos de usuarios (la rotación requiere su firma).
- Monitorear durante cada lote: rechazos del signer por motivo, salud del HSM (`/v1/health`), latencia de firma y
  saldo de gas de las S nuevas.
- Wallets nuevas: recién cuando el lote piloto terminó sin incidentes, el backend asigna shards HSM al crear wallets.

## Rollback

- Antes de ejecutar: cancelar la propuesta (U o R) durante las 48 h. Nada cambia on-chain.
- Después de ejecutar: el camino de vuelta es otra rotación de S (hacia una clave de un shard software), con la
  misma firma del usuario y el mismo timelock. No hay atajos: el HSM nunca entrega la clave.

## Lo que no se hace

- No se exportan claves del HSM ni se importan keystores V3 existentes al HSM.
- No se reutiliza la credencial de desbloqueo de un shard software en el HSM.
- No se desactivan las reglas estáticas ni la política del signer durante la migración.
