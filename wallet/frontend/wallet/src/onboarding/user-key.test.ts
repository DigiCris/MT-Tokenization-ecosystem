// P17.T05 [F-KEY-01..06]: alta de U — clave y Password U nuevas, sobre de la wallet con su AAD que abre con esa
// Password U, registro OPAQUE con AuthSecret_U (nunca la Password U) contra el servidor OPAQUE real y alta en la API con
// la dirección, el KDF público y los backups; AuthSecret_U se borra. Sin backup independiente no se sigue.
import { describe, expect, it, vi } from 'vitest';
import wordlistText from '../vendor/mtw-wordlist-v1.txt?raw';
import { keysForEnvelope, openEnvelope } from '../crypto/envelope.ts';
import type { Argon2 } from '../crypto/kdf.ts';
import { addressOf, isValidPrivateKey } from '../crypto/keys.ts';
import { parseWordlist } from '../crypto/wordlist.ts';
import { deriveArgon2id } from '../workers/argon2-protocol.ts';
import type { PlatformAuth } from '../api/request-signature.ts';
import { generateSessionKey } from '../api/session-key.ts';
import type { WalletApi } from '../api/wallet-api.ts';
import { startLogin } from '../unlock/opaque.ts';
import { opaqueTestServer } from '../unlock/opaque-server.test-helper.ts';
import {
  draftUserKey,
  hasIndependentBackup,
  ONBOARDING_KEY_VERSION,
  registerNewUserKey,
  sealUserKey,
} from './user-key.ts';

const wordlist = parseWordlist(wordlistText);
const argon2: Argon2 = (input) => deriveArgon2id(input);
const WALLET = '0b6b3c1e-2f3a-4c5d-8e9f-0a1b2c3d4e5f';

describe('alta de U', () => {
  it('clave válida, 5 palabras de la lista y sobre con la AAD de la wallet que abre con esa Password U', async () => {
    const draft = draftUserKey(wordlist);
    expect(isValidPrivateKey(draft.key)).toBe(true);
    expect(draft.address).toBe(addressOf(draft.key));
    expect(draft.passwordWords).toHaveLength(5);
    expect(draft.passwordWords.every((w) => wordlist.index.has(w))).toBe(true);
    const password = draft.passwordWords.join(' ');
    const sealed = await sealUserKey(
      draft,
      password,
      { platformId: 'mt-test', walletId: WALLET, keyVersion: ONBOARDING_KEY_VERSION },
      argon2,
    );
    expect(sealed.envelope).toMatchObject({
      platformId: 'mt-test',
      chainId: 8453,
      walletId: WALLET,
      role: 'U',
      keyAddress: draft.address,
      keyVersion: 1,
      kdf: { alg: 'argon2id', version: 19, memoryKiB: 65536, iterations: 3, parallelism: 4 },
    });
    expect(sealed.kdf).toEqual(sealed.envelope.kdf);
    expect(sealed.authSecret).toHaveLength(32);
    const keys = await keysForEnvelope(sealed.envelope, password, argon2);
    expect(addressOf(await openEnvelope(sealed.envelope, keys.encryptionKey))).toBe(draft.address);
    expect([...(keys.authSecret ?? [])]).toEqual([...sealed.authSecret]);
  });

  it('registro OPAQUE (AuthSecret_U) y alta de U por la API; el registro abre con esa Password U y AuthSecret_U se borra', async () => {
    const server = opaqueTestServer();
    const draft = draftUserKey(wordlist);
    const sealed = await sealUserKey(
      draft,
      draft.passwordWords.join(' '),
      { platformId: 'mt-test', walletId: WALLET, keyVersion: 1 },
      argon2,
    );
    const secret = new Uint8Array(sealed.authSecret);
    const platform: PlatformAuth = { token: 'jws', sessionId: crypto.randomUUID(), key: await generateSessionKey() };
    const api = {
      userKeyOpaqueRegistration: vi.fn<WalletApi['userKeyOpaqueRegistration']>((_p, walletId, request) =>
        Promise.resolve({ registrationResponse: server.registrationResponse(walletId, 1, request), keyVersion: 1 }),
      ),
      registerUserKey: vi.fn<WalletApi['registerUserKey']>((_p, walletId, input) => {
        server.records.set(server.identifier(walletId, 1), input.registrationRecord);
        return Promise.resolve({ userKey: input.userKey, keyVersion: 1, status: 'PENDING' as const });
      }),
    };
    const flags = { drive: true, file: true, qr: false, words: false };
    const result = await registerNewUserKey(api as unknown as WalletApi, platform, sealed, flags);
    expect(result).toEqual({ userKey: draft.address, keyVersion: 1, status: 'PENDING' });
    const body = api.registerUserKey.mock.calls[0]?.[2];
    expect(body).toMatchObject({ userKey: draft.address, kdfParams: sealed.kdf, storageFlags: flags });
    expect(Object.keys(body ?? {}).sort()).toEqual(['kdfParams', 'registrationRecord', 'storageFlags', 'userKey']);
    expect(JSON.stringify(api.registerUserKey.mock.calls)).not.toContain(draft.passwordWords.join(' '));
    expect(api.userKeyOpaqueRegistration.mock.calls[0]?.[0]).toBe(platform);
    expect(sealed.authSecret.every((b) => b === 0)).toBe(true);
    const login = await startLogin(secret);
    expect(login.finish(server.startLogin(WALLET, 1, login.startLoginRequest).loginResponse)).not.toBeNull();
  });

  it('hace falta un backup independiente de la plataforma (Drive solo no alcanza)', () => {
    expect(hasIndependentBackup({ drive: true, file: false, qr: false, words: false })).toBe(false);
    expect(hasIndependentBackup({ drive: false, file: true, qr: false, words: false })).toBe(true);
    expect(hasIndependentBackup({ drive: false, file: false, qr: true, words: false })).toBe(true);
    expect(hasIndependentBackup({ drive: false, file: false, qr: false, words: true })).toBe(true);
  });
});
