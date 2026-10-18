// A.1: la firma que manda la app es de U sobre el hash verificado localmente, con el envelope de envío firmado por la
// session key y la hora del cliente de la API (alineada con el servidor); el seguimiento se detiene en un estado final
// y corta por tiempo con el último estado.
import { keccak256, recoverAddress, toBytes } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/client.ts';
import { submissionCanonical } from '../api/submission.ts';
import { generateSessionKey, verifyP256 } from '../api/session-key.ts';
import type { OperationStatus, SignatureSubmission } from '../api/wallet-api.ts';
import { WalletApi } from '../api/wallet-api.ts';
import { assistedCall, safeTxHash, type VerifiedOperation } from '../chain/safe-tx.ts';
import { toBase64Url } from '../crypto/bytes.ts';
import { sealKey } from '../crypto/envelope.ts';
import { defaultKdfParams } from '../crypto/kdf.ts';
import { addressOf } from '../crypto/keys.ts';
import { OperationWaitTimeout, signAndSubmit, waitForOperation } from './sign.ts';

const SAFE = '0x2Ffa853A9213C92A16295C55FA6A5b27A6498688';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';

function status(state: OperationStatus['status']): OperationStatus {
  return { id: OPERATION_ID, status: state } as OperationStatus;
}

async function unlockedFixture() {
  const key = toBytes(keccak256(toBytes('mtw-user-key')));
  const encryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const envelope = await sealKey(
    key.slice(),
    encryptionKey,
    { platformId: 'mt-default', chainId: 8453, walletId: 'w', role: 'U', keyAddress: addressOf(key), keyVersion: 1 },
    defaultKdfParams(toBase64Url(new Uint8Array(16))),
  );
  const sessionKey = await generateSessionKey();
  return {
    userAddress: addressOf(key),
    unlocked: {
      envelope,
      encryptionKey,
      platform: { token: 'jws', sessionId: '22222222-2222-4222-8222-222222222222', key: sessionKey },
      session: {} as never,
    },
  };
}

describe('firma y envío (A.1)', () => {
  it('U firma el hash local y el envelope ata operación, hash y sesión', async () => {
    const { unlocked, userAddress } = await unlockedFixture();
    const client = new ApiClient({
      baseUrl: 'https://api.example/api/v1',
      fetch: () => Promise.reject(new Error('x')),
    });
    vi.spyOn(client, 'now').mockReturnValue(Date.parse('2026-10-18T12:00:30Z'));
    const api = new WalletApi(client);
    const submit = vi.spyOn(api, 'submitOperationSignature').mockResolvedValue(status('QUEUED'));
    const tx = assistedCall(SAFE, '0x', 3n);
    const hash = safeTxHash(8453, SAFE, tx);
    const verified = { operation: { operationId: OPERATION_ID }, safeTx: tx, hash } as unknown as VerifiedOperation;

    await expect(signAndSubmit(api, unlocked, verified, { twoFactorChallengeId: 'c' })).resolves.toMatchObject({
      status: 'QUEUED',
    });
    const [platform, operationId, body] = submit.mock.calls[0] as [unknown, string, SignatureSubmission];
    expect(platform).toBe(unlocked.platform);
    expect(operationId).toBe(OPERATION_ID);
    expect(await recoverAddress({ hash, signature: body.ownerSignature })).toBe(userAddress);
    expect(body.ownerRole).toBe('U');
    expect(body.twoFactorChallengeId).toBe('c');
    expect(body.submissionEnvelope).toEqual({
      operationId: OPERATION_ID,
      safeTxHash: hash,
      sessionId: unlocked.platform.sessionId,
      submittedAt: Date.parse('2026-10-18T12:00:30Z') / 1000,
    });
    expect(
      await verifyP256(
        unlocked.platform.key.publicJwk,
        submissionCanonical(body.submissionEnvelope),
        body.submissionEnvelopeSignature,
      ),
    ).toBe(true);
  });

  it('el seguimiento termina en un estado final o corta por tiempo con el último', async () => {
    const api = new WalletApi(new ApiClient({ baseUrl: 'https://api.example/api/v1' }));
    const seen: string[] = [];
    vi.spyOn(api, 'operation')
      .mockResolvedValueOnce(status('QUEUED'))
      .mockResolvedValueOnce(status('SUBMITTED'))
      .mockResolvedValueOnce(status('MINED'));
    const sleep = vi.fn(() => Promise.resolve());
    await expect(
      waitForOperation(api, OPERATION_ID, { sleep, onUpdate: (s) => seen.push(s.status) }),
    ).resolves.toMatchObject({ status: 'MINED' });
    expect(seen).toEqual(['QUEUED', 'SUBMITTED', 'MINED']);

    let clock = 0;
    vi.spyOn(api, 'operation').mockResolvedValue(status('VALIDATING'));
    const timeout = waitForOperation(api, OPERATION_ID, {
      sleep: () => {
        clock += 1_000;
        return Promise.resolve();
      },
      now: () => clock,
      timeoutMs: 3_000,
    });
    await expect(timeout).rejects.toBeInstanceOf(OperationWaitTimeout);
    await expect(timeout).rejects.toMatchObject({ last: { status: 'VALIDATING' } });
  });

  it('se puede cortar el seguimiento', async () => {
    const api = new WalletApi(new ApiClient({ baseUrl: 'https://api.example/api/v1' }));
    const controller = new AbortController();
    controller.abort();
    await expect(waitForOperation(api, OPERATION_ID, { signal: controller.signal })).rejects.toThrow();
  });
});
