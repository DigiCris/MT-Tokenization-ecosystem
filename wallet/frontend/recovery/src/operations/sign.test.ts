// P19: firma y envío de una operación por R. La firma de R sobre la SafeTx verificada es la del vector (estricta), el
// sobre de envío lo firma la session key y verifica con su pública; una firma que no recupera a R no se envía. El estado
// se sigue hasta que la operación se mina o muere, y lo preparado sin firmar se cancela (libera el nonce).
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import safeTxVectors from '../../test/vectors/safe-tx.json' with { type: 'json' };
import { ServerClock } from '../api/client.ts';
import type { OperationState, OperationStatus, PreparedOperation, RecoveryApi } from '../api/recovery-api.ts';
import { generateSessionKey, verifyP256 } from '../api/session-key.ts';
import { submissionCanonical, type SubmissionEnvelope } from '../api/submission.ts';
import { parseSafeTx, safeTxHash, type VerifiedOperation } from '../chain/safe-tx.ts';
import { addressOfKey, signDigest } from '../crypto/secp256k1.ts';
import { typedDataDigest } from '../crypto/typed-data.ts';
import type { PlatformSession } from '../session/store.ts';
import type { RecoverySigner } from '../signer/recovery-signer.ts';
import {
  markSigned,
  OperationWaitTimeout,
  RecoverySignatureError,
  releasePrepared,
  submitRecoverySignature,
  verifiedOrReleased,
  waitForOperation,
} from './sign.ts';

const R_KEY = toBytes(keccak256(toBytes('mtw-recovery-key')));
const OTHER_KEY = toBytes(keccak256(toBytes('otra')));
const safe = safeTxVectors.safe as Address;
const vector = safeTxVectors.operations.find((o) => o.opType === 'NOOP');
if (!vector) throw new Error('falta el vector NOOP');
const tx = parseSafeTx({
  to: vector.to as Address,
  value: vector.value,
  data: vector.data as Hex,
  operation: vector.operation as 0 | 1,
  safeTxGas: vector.safeTxGas,
  baseGas: vector.baseGas,
  gasPrice: vector.gasPrice,
  gasToken: vector.gasToken as Address,
  refundReceiver: vector.refundReceiver as Address,
  nonce: String(vector.nonce),
});

function signer(key: Uint8Array, address: Address = addressOfKey(key)): RecoverySigner {
  return {
    kind: 'internal',
    address,
    walletId: null,
    signTypedData: (definition) => Promise.resolve(signDigest(typedDataDigest(definition), key)),
    sendTransaction: null,
  };
}

const operation = { operationId: 'op-1', safe, chainId: 8453, operationType: 'NOOP_CANCEL' } as PreparedOperation;
const verified: VerifiedOperation = { operation, safeTx: tx, hash: safeTxHash(8453, safe, tx) };

function status(id: string, state: OperationState): OperationStatus {
  return { id, status: state } as OperationStatus;
}

describe('firma de R', () => {
  it('la firma es la del vector, el sobre lo firma la session key y verifica con su pública', async () => {
    const key = await generateSessionKey();
    const platform = { auth: { token: 't', sessionId: 'ps-1', key: key.privateKey } } as PlatformSession;
    const sent: { ownerSignature: Hex; submissionEnvelope: SubmissionEnvelope; submissionEnvelopeSignature: string }[] =
      [];
    const api = {
      client: { clock: new ServerClock() },
      submitSignature: (_: unknown, operationId: string, body: (typeof sent)[number]) => {
        sent.push(body);
        return Promise.resolve(status(operationId, 'USER_SIGNED'));
      },
    } as unknown as Pick<RecoveryApi, 'submitSignature' | 'client'>;
    await submitRecoverySignature(api, platform, signer(R_KEY), verified);
    const [body] = sent;
    expect(verified.hash).toBe(vector.safeTxHash);
    expect(body?.ownerSignature).toBe(vector.signatureRecovery);
    expect(body?.submissionEnvelope).toMatchObject({
      operationId: 'op-1',
      safeTxHash: vector.safeTxHash,
      sessionId: 'ps-1',
    });
    if (!body) throw new Error('sin envío');
    expect(
      await verifyP256(key.publicJwk, submissionCanonical(body.submissionEnvelope), body.submissionEnvelopeSignature),
    ).toBe(true);
  });

  it('una wallet que firma con otra cuenta: la firma no se envía', async () => {
    const api = { client: { clock: new ServerClock() }, submitSignature: () => Promise.reject(new Error('no')) };
    const key = await generateSessionKey();
    const platform = { auth: { token: 't', sessionId: 'ps', key: key.privateKey } } as PlatformSession;
    await expect(
      submitRecoverySignature(api as never, platform, signer(OTHER_KEY, addressOfKey(R_KEY)), verified),
    ).rejects.toBeInstanceOf(RecoverySignatureError);
  });
});

describe('estado y lo preparado sin firmar', () => {
  it('sigue el estado hasta que se mina; si no termina a tiempo, lo avisa', async () => {
    const states: OperationState[] = ['QUEUED', 'SUBMITTED', 'MINED'];
    const seen: OperationState[] = [];
    const api = { operation: (id: string) => Promise.resolve(status(id, states.shift() ?? 'MINED')) };
    const final = await waitForOperation(api, 'op', { intervalMs: 0, onUpdate: (s) => seen.push(s.status) });
    expect(final.status).toBe('MINED');
    expect(seen).toEqual(['QUEUED', 'SUBMITTED', 'MINED']);
    const stuck = { operation: (id: string) => Promise.resolve(status(id, 'QUEUED')) };
    await expect(waitForOperation(stuck, 'op', { intervalMs: 0, timeoutMs: -1 })).rejects.toBeInstanceOf(
      OperationWaitTimeout,
    );
    const dead = { operation: (id: string) => Promise.resolve(status(id, 'CANCELLED')) };
    expect((await waitForOperation(dead, 'op', { intervalMs: 0 })).status).toBe('CANCELLED');
  });

  it('si la verificación falla, lo preparado en CREATED se cancela; lo firmado no', async () => {
    const cancelled: string[] = [];
    const states: Record<string, OperationState> = { a: 'CREATED', b: 'USER_SIGNED', c: 'CREATED' };
    const api = {
      operation: (id: string) => Promise.resolve(status(id, states[id] ?? 'EXPIRED')),
      cancelOperation: (_: unknown, id: string) => {
        cancelled.push(id);
        return Promise.resolve({ operation: status(id, 'CANCELLED'), noop: null });
      },
    } as unknown as Pick<RecoveryApi, 'operation' | 'cancelOperation'>;
    const platform = { auth: {} } as PlatformSession;
    const prepared = ['a', 'b'].map((operationId) => ({ operationId }) as PreparedOperation);
    await expect(
      verifiedOrReleased(api, platform, prepared, () => {
        throw new Error('no coincide');
      }),
    ).rejects.toThrow('no coincide');
    expect(cancelled).toEqual(['a']);
    // Verificada y firmada: ya no se cancela al liberar lo pendiente de la pestaña.
    expect(await verifiedOrReleased(api, platform, [{ operationId: 'c' } as PreparedOperation], () => 'ok')).toBe('ok');
    markSigned('c');
    await releasePrepared(api, platform);
    expect(cancelled).toEqual(['a']);
  });

  it('una operación que ya venció o no existe se ignora al liberar', async () => {
    const api = {
      operation: () => Promise.reject(new Error('404')),
      cancelOperation: () => Promise.reject(new Error('no se llama')),
    } as unknown as Pick<RecoveryApi, 'operation' | 'cancelOperation'>;
    await expect(releasePrepared(api, { auth: {} } as PlatformSession, ['x'])).resolves.toBeUndefined();
  });
});
