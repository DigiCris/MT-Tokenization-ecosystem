// P18.MAN (actividad): la vista de una operación ([B-API-SCH] `OperationStatus`) trae su intención desde
// `canonical_intent` (monto, token y destino), también si no llegó a la cadena (cancelada antes de firmar, vencida):
// la actividad de la app la muestra sin depender de los transfers indexados. Función pura: sin base ni fork.
import { describe, expect, it } from 'vitest';
import type { CanonicalIntent } from '../../src/operations/intent.ts';
import { operationView } from '../../src/operations/service.ts';

type Row = Parameters<typeof operationView>[0];

const SAFE = '0x00000000000000000000000000000000000000A1';
const DESTINATION = '0x6DFD2d76000000000000000000000000000E3a23';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function intent(decoded: CanonicalIntent['decoded']): CanonicalIntent {
  return {
    version: 1,
    chainId: 8453,
    safe: SAFE,
    operationType: 'SEND',
    ownerRole: 'U',
    safeTx: {
      to: USDC,
      value: '0',
      data: '0x',
      operation: 0,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: '7',
    },
    decoded,
  };
}

function row(patch: Partial<Row>): Row {
  const created = new Date('2026-10-19T10:00:00.000Z');
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    user_id: '018f0000-0000-7000-8000-0000000000aa',
    wallet_id: '018f0000-0000-7000-8000-0000000000bb',
    safe_address: Buffer.from(SAFE.slice(2), 'hex'),
    chain_id: 8453,
    safe_nonce: '7',
    operation_type: 'SEND',
    group_id: null,
    safe_tx_hash: Buffer.alloc(32, 0xab),
    target: Buffer.from(USDC.slice(2), 'hex'),
    value: '0',
    calldata: Buffer.alloc(0),
    canonical_intent: intent({ token: 'USDC', amount: '2500000', destination: DESTINATION }),
    owner_signature: null,
    owner_role: null,
    s_signature: null,
    platform_session_id: null,
    submission_envelope: null,
    policy_snapshot_version: 1,
    two_factor_challenge_id: null,
    status: 'CANCELLED',
    failure_reason: 'CANCELLED_BY_USER',
    last_error_code: null,
    retry_count: 0,
    next_attempt_at: null,
    lease_version: '0',
    created_at: created,
    updated_at: created,
    submitted_at: null,
    mined_at: null,
    executed_at: null,
    confirmed_at: null,
    finalized_at: null,
    tx_hash: null,
    block_number: null,
    block_hash: null,
    expires_at: new Date('2026-10-19T10:15:00.000Z'),
    blocked_reason: null,
    submission_envelope_signature: null,
    platform_session_token: null,
    challenge_attestation: null,
    requires_two_factor: false,
    signed_at: null,
    cancels_operation_id: null,
    ...patch,
  };
}

describe('operationView: intención de la operación', () => {
  it('un envío cancelado antes de firmar trae monto, token y destino aunque no tenga transacción', () => {
    const view = operationView(row({}), [
      { status: 'CREATED', at: '2026-10-19T10:00:00.000Z' },
      { status: 'CANCELLED', at: '2026-10-19T10:01:00.000Z' },
    ]);
    expect(view).toMatchObject({
      operationType: 'SEND',
      status: 'CANCELLED',
      txHash: null,
      decoded: { token: 'USDC', amount: '2500000', destination: DESTINATION },
    });
    expect(view.history.map((h) => h.status)).toEqual(['CREATED', 'CANCELLED']);
  });

  it('una operación sin datos decodificados (NoOp) devuelve la intención vacía', () => {
    const view = operationView(
      row({ operation_type: 'NOOP_CANCEL', canonical_intent: { ...intent({}), operationType: 'NOOP_CANCEL' } }),
      [],
    );
    expect(view.decoded).toEqual({});
  });
});
