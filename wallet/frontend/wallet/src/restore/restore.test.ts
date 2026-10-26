// P17.T09 [F-KEY-10]: restauración desde las 17 palabras — sólo si la dirección es el rol U on-chain (si no, la clave se
// borra y falla), prueba de posesión KeyRestore firmada con el nonce del step-up, sobre nuevo con la versión vigente que
// informa el paso 1 de OPAQUE y reemplazo del registro con el KDF y los backups nuevos. Contra la cadena y el backend
// reales: test/browser/stack/restore.spec.ts.
import { describe, expect, it, vi } from 'vitest';
import { recoverTypedDataAddress, type Address } from 'viem';
import wordlistText from '../vendor/mtw-wordlist-v1.txt?raw';
import { keyToBackupWords } from '../crypto/backup-words.ts';
import { keysForEnvelope, openEnvelope } from '../crypto/envelope.ts';
import type { Argon2 } from '../crypto/kdf.ts';
import { addressOf, generatePrivateKey } from '../crypto/keys.ts';
import { keyRestore } from '../crypto/typed-data.ts';
import { parseWordlist } from '../crypto/wordlist.ts';
import { deriveArgon2id } from '../workers/argon2-protocol.ts';
import { ApiError, NetworkError } from '../api/problem.ts';
import { generateSessionKey } from '../api/session-key.ts';
import type { WalletApi } from '../api/wallet-api.ts';
import type { OnchainRoles } from '../chain/roles.ts';
import type { PendingStepUp, StepUpSession } from '../session/step-up.ts';
import { opaqueTestServer, opaqueUnlockApi } from '../unlock/opaque-server.test-helper.ts';
import { unlockWallet } from '../unlock/unlock.ts';
import {
  commitRestore,
  finishKeyRestoreStepUp,
  keyFromWords,
  prepareRestoredEnvelope,
  RestoreError,
} from './restore.ts';

const wordlist = parseWordlist(wordlistText);
const argon2: Argon2 = (input) => deriveArgon2id(input);
const WALLET = '2d3e4f5a-6b7c-4d8e-9fa0-b1c2d3e4f5a6';
const USER = '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7';
const FACTORY = '0x1d1499e622D69689cdf9004d05Ec547d650Ff211';
const RECOVERY: Address = '0x7184D30100a188c9F869ccB6883392534ecD6C9d';
const EXECUTOR: Address = '0xc80D387fCc59cB57AEf0eC2b137C77D26474288E';
const roles = (userKey: Address) => (): Promise<OnchainRoles> =>
  Promise.resolve({ userKey, recoveryKey: RECOVERY, executor: EXECUTOR });

describe('restauración desde las 17 palabras', () => {
  it('sólo la U vigente on-chain; otra clave se rechaza y se borra', async () => {
    const key = generatePrivateKey();
    const words = await keyToBackupWords('U', key, wordlist);
    const restored = await keyFromWords(words, wordlist, roles(addressOf(key)));
    expect(restored.address).toBe(addressOf(key));
    const other = generatePrivateKey();
    const error = await keyFromWords(words, wordlist, roles(addressOf(other))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RestoreError);
    expect((error as Error).message).toContain(addressOf(other));
    // Una dirección no es la clave: el texto la nombra como dirección de la clave.
    expect((error as Error).message).toBe(
      `Estas palabras son de la clave con la dirección ${addressOf(key)}, pero la dirección de la clave U vigente de ` +
        `tu Safe es ${addressOf(other)}: no se restaura`,
    );
  });

  it('KeyRestore firmado por U con el nonce del step-up; sin nonce no se completa', async () => {
    const key = generatePrivateKey();
    const address = addressOf(key);
    const pending: PendingStepUp = {
      scope: 'KEY_RESTORE',
      challengeId: crypto.randomUUID(),
      expiresAt: new Date().toISOString(),
      key: await generateSessionKey(),
      keyRestoreNonce: `0x${'ab'.repeat(32)}`,
    };
    const api = {
      stepUpFinish: vi.fn<WalletApi['stepUpFinish']>(() =>
        Promise.resolve({
          token: 'jws',
          csrfToken: 'csrf',
          session: {
            id: crypto.randomUUID(),
            scope: 'KEY_RESTORE' as const,
            authMethod: 'STEP_UP' as const,
            walletId: WALLET,
            safe: null,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          },
        }),
      ),
    };
    const session = await finishKeyRestoreStepUp(
      api as unknown as WalletApi,
      pending,
      { code: '12345678' },
      { key, address },
      {
        userId: USER,
        walletId: WALLET,
        walletFactory: FACTORY,
      },
    );
    expect(session.platform.key).toBe(pending.key);
    const sent = api.stepUpFinish.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      challengeId: pending.challengeId,
      code: '12345678',
      keyRestore: { keyAddress: address },
    });
    const signer = await recoverTypedDataAddress({
      ...keyRestore(FACTORY, { userId: USER, walletId: WALLET, keyAddress: address, nonce: `0x${'ab'.repeat(32)}` }),
      signature: sent?.keyRestore?.signature ?? '0x',
    });
    expect(signer).toBe(address);
    await expect(
      finishKeyRestoreStepUp(
        api as unknown as WalletApi,
        { ...pending, keyRestoreNonce: null },
        { code: '1' },
        { key, address },
        {
          userId: USER,
          walletId: WALLET,
          walletFactory: FACTORY,
        },
      ),
    ).rejects.toThrow('nonce');
  });

  it('sobre nuevo con la versión vigente y reemplazo del registro con KDF y backups', async () => {
    const server = opaqueTestServer();
    const key = generatePrivateKey();
    const address = addressOf(key);
    const stepUp: StepUpSession = {
      platform: { token: 'jws', sessionId: crypto.randomUUID(), key: await generateSessionKey() },
      session: {
        id: crypto.randomUUID(),
        scope: 'KEY_RESTORE',
        authMethod: 'STEP_UP',
        walletId: WALLET,
        safe: null,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      },
    };
    const api = {
      userKeyOpaqueRegistration: vi.fn<WalletApi['userKeyOpaqueRegistration']>((_p, walletId, request) =>
        Promise.resolve({ registrationResponse: server.registrationResponse(walletId, 3, request), keyVersion: 3 }),
      ),
      restoreUserKey: vi.fn<WalletApi['restoreUserKey']>(() =>
        Promise.resolve({ userKey: address, keyVersion: 3, status: 'ACTIVE' as const }),
      ),
    };
    const password = 'meshier boom riming rejection dingily';
    const prepared = await prepareRestoredEnvelope(
      api as unknown as WalletApi,
      stepUp,
      { key, address },
      password,
      'mt-test',
      argon2,
    );
    expect(prepared.envelope).toMatchObject({ keyAddress: address, keyVersion: 3, walletId: WALLET, role: 'U' });
    const keys = await keysForEnvelope(prepared.envelope, password, argon2);
    expect(addressOf(await openEnvelope(prepared.envelope, keys.encryptionKey))).toBe(address);
    const flags = { drive: true, file: false, qr: false, words: true };
    await commitRestore(api as unknown as WalletApi, stepUp, prepared, flags);
    expect(api.restoreUserKey).toHaveBeenCalledWith(stepUp.platform, WALLET, {
      registrationRecord: prepared.registrationRecord,
      kdfParams: prepared.kdf,
      storageFlags: flags,
    });
  });

  it('un intento que falla (5xx o red) se reintenta y la Password U nueva desbloquea después (N1)', async () => {
    const server = opaqueTestServer();
    const key = generatePrivateKey();
    const address = addressOf(key);
    const stepUp: StepUpSession = {
      platform: { token: 'jws', sessionId: crypto.randomUUID(), key: await generateSessionKey() },
      session: {
        id: crypto.randomUUID(),
        scope: 'KEY_RESTORE',
        authMethod: 'STEP_UP',
        walletId: WALLET,
        safe: null,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      },
    };
    let opaqueCalls = 0;
    let restoreCalls = 0;
    const api = {
      userKeyOpaqueRegistration: vi.fn<WalletApi['userKeyOpaqueRegistration']>((_p, walletId, request) => {
        if (opaqueCalls++ === 0) {
          return Promise.reject(
            new ApiError({
              type: 'about:blank',
              title: 'Error',
              status: 503,
              code: 'SERVICE_UNAVAILABLE',
              requestId: 't',
            }),
          );
        }
        return Promise.resolve({
          registrationResponse: server.registrationResponse(walletId, 3, request),
          keyVersion: 3,
        });
      }),
      restoreUserKey: vi.fn<WalletApi['restoreUserKey']>((_p, walletId, input) => {
        if (restoreCalls++ === 0) return Promise.reject(new NetworkError('No se pudo contactar a la plataforma'));
        server.records.set(server.identifier(walletId, 3), input.registrationRecord);
        return Promise.resolve({ userKey: address, keyVersion: 3, status: 'ACTIVE' as const });
      }),
    };
    const password = 'meshier boom riming rejection dingily';
    const restored = { key, address };
    await expect(
      prepareRestoredEnvelope(api as unknown as WalletApi, stepUp, restored, password, 'mt-test', argon2),
    ).rejects.toThrow();
    const prepared = await prepareRestoredEnvelope(
      api as unknown as WalletApi,
      stepUp,
      restored,
      password,
      'mt-test',
      argon2,
    );
    const flags = { drive: false, file: true, qr: false, words: false };
    await expect(commitRestore(api as unknown as WalletApi, stepUp, prepared, flags)).rejects.toThrow();
    await commitRestore(api as unknown as WalletApi, stepUp, prepared, flags);
    const unlocked = await unlockWallet(
      opaqueUnlockApi(server, 3) as unknown as WalletApi,
      prepared.envelope,
      password,
      argon2,
    );
    expect(unlocked.session.scope).toBe('OPERATIONS');
  });
});
