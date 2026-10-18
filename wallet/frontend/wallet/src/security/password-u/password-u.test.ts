// P17.T07: cambio de Password U [F-KEY-08] — la misma U re-cifrada con salt, nonce y K nuevos (abre con la nueva y no
// con la vieja), registro OPAQUE nuevo con la PlatformSession OPERATIONS y la API de cambio con el KDF y los backups
// nuevos — y "perdí mi Password U": sobre de U' con la versión que asigna el backend, registro OPAQUE, KeyAcceptance
// firmada por U' (EIP-712 de la plataforma) y link de handoff a Recovery con la rotación y U' en el fragmento.
import { describe, expect, it, vi } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import wordlistText from '../../vendor/mtw-wordlist-v1.txt?raw';
import { keysForEnvelope, openEnvelope } from '../../crypto/envelope.ts';
import type { Argon2 } from '../../crypto/kdf.ts';
import { addressOf } from '../../crypto/keys.ts';
import { keyAcceptance } from '../../crypto/typed-data.ts';
import { parseWordlist } from '../../crypto/wordlist.ts';
import { deriveArgon2id } from '../../workers/argon2-protocol.ts';
import { generateSessionKey } from '../../api/session-key.ts';
import type { WalletApi } from '../../api/wallet-api.ts';
import { draftUserKey, sealUserKey } from '../../onboarding/user-key.ts';
import type { StepUpSession } from '../../session/step-up.ts';
import { startLogin } from '../../unlock/opaque.ts';
import { opaqueTestServer } from '../../unlock/opaque-server.test-helper.ts';
import type { UnlockedWallet } from '../../unlock/unlock.ts';
import { commitNewPassword, resealWithNewPassword } from './change.ts';
import { prepareReplacement, recoveryHandoffUrl, registerReplacement } from './lost.ts';

const wordlist = parseWordlist(wordlistText);
const argon2: Argon2 = (input) => deriveArgon2id(input);
const WALLET = '1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5';
const FACTORY = '0x1d1499e622D69689cdf9004d05Ec547d650Ff211';

async function unlockedWallet(): Promise<{ unlocked: UnlockedWallet; key: Uint8Array; password: string }> {
  const draft = draftUserKey(wordlist);
  const password = draft.passwordWords.join(' ');
  const sealed = await sealUserKey(draft, password, { platformId: 'mt-test', walletId: WALLET, keyVersion: 1 }, argon2);
  const platform = { token: 'jws', sessionId: crypto.randomUUID(), key: await generateSessionKey() };
  return {
    key: draft.key,
    password,
    unlocked: {
      envelope: sealed.envelope,
      encryptionKey: sealed.encryptionKey,
      platform,
      session: {
        id: platform.sessionId,
        scope: 'OPERATIONS',
        authMethod: 'OPAQUE_U',
        walletId: WALLET,
        safe: null,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      },
    },
  };
}

describe('cambio de Password U [F-KEY-08]', () => {
  it('la misma U con un sobre nuevo: abre con la Password U nueva y no con la vieja', async () => {
    const { unlocked, key, password } = await unlockedWallet();
    const newPassword = draftUserKey(wordlist).passwordWords.join(' ');
    const resealed = await resealWithNewPassword(unlocked, newPassword, argon2);
    expect(resealed.envelope).toMatchObject({
      keyAddress: unlocked.envelope.keyAddress,
      walletId: WALLET,
      role: 'U',
      keyVersion: 1,
      platformId: 'mt-test',
    });
    expect(resealed.envelope.kdf.salt).not.toBe(unlocked.envelope.kdf.salt);
    expect(resealed.envelope.cipher.nonce).not.toBe(unlocked.envelope.cipher.nonce);
    const fresh = await keysForEnvelope(resealed.envelope, newPassword, argon2);
    expect(addressOf(await openEnvelope(resealed.envelope, fresh.encryptionKey))).toBe(addressOf(key));
    const old = await keysForEnvelope(resealed.envelope, password, argon2);
    await expect(openEnvelope(resealed.envelope, old.encryptionKey)).rejects.toThrow();
  });

  it('registro OPAQUE nuevo con OPERATIONS y cambio en la API; el desbloqueo sigue con el sobre y K nuevos', async () => {
    const server = opaqueTestServer();
    const { unlocked } = await unlockedWallet();
    const newPassword = draftUserKey(wordlist).passwordWords.join(' ');
    const resealed = await resealWithNewPassword(unlocked, newPassword, argon2);
    const secret = new Uint8Array(resealed.authSecret);
    const api = {
      userKeyOpaqueRegistration: vi.fn<WalletApi['userKeyOpaqueRegistration']>((_p, walletId, request) =>
        Promise.resolve({ registrationResponse: server.registrationResponse(walletId, 1, request), keyVersion: 1 }),
      ),
      changeUserKeyPassword: vi.fn<WalletApi['changeUserKeyPassword']>((_p, walletId, input) => {
        server.records.set(server.identifier(walletId, 1), input.registrationRecord);
        return Promise.resolve({ userKey: unlocked.envelope.keyAddress, keyVersion: 1, status: 'ACTIVE' as const });
      }),
    };
    const flags = { drive: true, file: true, qr: false, words: false };
    const next = await commitNewPassword(api as unknown as WalletApi, unlocked, resealed, flags);
    expect(next.envelope).toBe(resealed.envelope);
    expect(next.encryptionKey).toBe(resealed.encryptionKey);
    expect(next.platform).toBe(unlocked.platform);
    expect(api.userKeyOpaqueRegistration.mock.calls[0]?.[0]).toBe(unlocked.platform);
    expect(api.changeUserKeyPassword.mock.calls[0]?.[2]).toMatchObject({
      kdfParams: resealed.kdf,
      storageFlags: flags,
    });
    expect(resealed.authSecret.every((b) => b === 0)).toBe(true);
    const login = await startLogin(secret);
    expect(login.finish(server.startLogin(WALLET, 1, login.startLoginRequest).loginResponse)).not.toBeNull();
  });
});

describe('perdí mi Password U', () => {
  it("U' con la versión del backend, registro OPAQUE y KeyAcceptance firmada por U'", async () => {
    const server = opaqueTestServer();
    const draft = draftUserKey(wordlist);
    const stepUp: StepUpSession = {
      platform: { token: 'jws', sessionId: crypto.randomUUID(), key: await generateSessionKey() },
      session: {
        id: crypto.randomUUID(),
        scope: 'U_REPLACEMENT',
        authMethod: 'STEP_UP',
        walletId: WALLET,
        safe: null,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      },
    };
    const api = {
      userKeyOpaqueRegistration: vi.fn<WalletApi['userKeyOpaqueRegistration']>((_p, walletId, request) =>
        Promise.resolve({ registrationResponse: server.registrationResponse(walletId, 2, request), keyVersion: 2 }),
      ),
      registerReplacementUserKey: vi.fn<WalletApi['registerReplacementUserKey']>((_p, input) =>
        Promise.resolve({
          rotationId: 'f0e1d2c3-b4a5-4968-8776-655443322110',
          walletId: WALLET,
          userKey: input.userKey,
          keyVersion: 2,
          status: 'DRAFT' as const,
        }),
      ),
    };
    const prepared = await prepareReplacement(
      api as unknown as WalletApi,
      stepUp,
      draft,
      draft.passwordWords.join(' '),
      'mt-test',
      argon2,
    );
    expect(prepared.keyVersion).toBe(2);
    expect(prepared.envelope).toMatchObject({ keyAddress: draft.address, keyVersion: 2, walletId: WALLET });
    const opened = await keysForEnvelope(prepared.envelope, draft.passwordWords.join(' '), argon2);
    expect(addressOf(await openEnvelope(prepared.envelope, opened.encryptionKey))).toBe(draft.address);

    const flags = { drive: false, file: true, qr: false, words: true };
    const result = await registerReplacement(api as unknown as WalletApi, stepUp, draft, prepared, flags, FACTORY);
    expect(result).toEqual({
      rotationId: 'f0e1d2c3-b4a5-4968-8776-655443322110',
      walletId: WALLET,
      userKey: draft.address,
    });
    const body = api.registerReplacementUserKey.mock.calls[0]?.[1];
    expect(body).toMatchObject({
      userKey: draft.address,
      kdfParams: prepared.kdf,
      storageFlags: flags,
      registrationRecord: prepared.registrationRecord,
    });
    const { nonce, signature } = body?.keyAcceptance ?? { nonce: '0x', signature: '0x' };
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    const signer = await recoverTypedDataAddress({
      ...keyAcceptance(FACTORY, { walletId: WALLET, role: 'U', newKey: draft.address, nonce }),
      signature,
    });
    expect(signer).toBe(draft.address);
  });

  it("el handoff a Recovery lleva la rotación y U' en el fragmento (no llega a servidores)", () => {
    const url = new URL(
      recoveryHandoffUrl('https://recovery.example', 'rot-1', '0x79406Eb1d6abdA075A9789DBD7d31626FEFE2904'),
    );
    expect(url.origin + url.pathname + url.search).toBe('https://recovery.example/recover-u');
    expect(Object.fromEntries(new URLSearchParams(url.hash.slice(1)))).toEqual({
      rid: 'rot-1',
      u: '0x79406Eb1d6abdA075A9789DBD7d31626FEFE2904',
    });
  });
});
