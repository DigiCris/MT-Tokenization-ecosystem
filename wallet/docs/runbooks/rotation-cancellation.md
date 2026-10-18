# Runbook: cancelar una rotación sin el backend

Cualquier rotación pendiente (48 h, ADR-007) se cancela con la firma individual de la U **o** la R vigentes
([C-RTL-03], P15.T02). La API la retransmite por el gas tank (`POST /rotations/{id}/cancel`, sin autenticación), pero
la firma también se puede transmitir **sin la plataforma**: por cualquier relayer o con una wallet propia desde
Recovery. Lo prueba `backend/app/test/integration/rotation-cancel.test.ts` (relay del backend y relayer ajeno).

## Qué se firma

EIP-712 `CancelRotation(bytes32 proposalId, address safe)` con el dominio del `RotationTimelock` de la propuesta:

| Campo | Valor |
|---|---|
| `name` | `MTW RotationTimelock` |
| `version` | `1` |
| `chainId` | `8453` |
| `verifyingContract` | el `RotationTimelock` que recibió la propuesta (el del Guard que gobierna la Safe; tras un upgrade del Guard, el del sucesor) |

`GET /wallets/{id}/rotations` devuelve la typed data lista para `eth_signTypedData_v4` (`cancelTypedData`) mientras la
propuesta está pendiente. Sin la API, el `proposalId` está en el evento `RotationProposed(id, safe, kind, old, new,
executableAt)` del timelock y en `activeProposal(safe, kind)`.

## Transmitir

- **Por la plataforma**: `POST /rotations/{id}/cancel` con `{ "signature": "0x…" }`. Verifica la firma (U o R
  vigentes) y que la propuesta siga pendiente, y la retransmite (rate limit propio: 10 por hora por propuesta).
- **Por cualquier relayer o wallet propia** (paga el gas):

```bash
cast send <RotationTimelock> "cancelWithSignature(bytes32,bytes)" <proposalId> <firma de 65 bytes> \
  --rpc-url <RPC de Base> --private-key <clave del relayer>
```

El timelock verifica la firma (sin maleabilidad) contra los roles vigentes de la Safe en su Guard; cualquier otra clave
revierte (`NotCurrentUserOrRecovery`). La plataforma refleja la cancelación al indexar `RotationCancelled` (estado
`CANCELLED`, email y notificación), venga de donde venga.
