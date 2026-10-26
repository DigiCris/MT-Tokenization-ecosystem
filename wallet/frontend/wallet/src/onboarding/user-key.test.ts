// P17.T05 [F-KEY-01..06]: alta de U — clave y Password U nuevas, sobre de la wallet con su AAD que abre con esa
// Password U, registro OPAQUE con AuthSecret_U (nunca la Password U) contra el servidor OPAQUE real y alta en la API con
// la dirección, el KDF público y los backups; AuthSecret_U se borra. Sin backup independiente no se sigue. Cuarta
// revisión de P17.MAN: el archivo, lo impreso, lo anotado y el papel de la Password U llevan la dirección de esa U.
// Verificación de P17.MAN: un registro que falla se reintenta con el mismo AuthSecret_U y la Password U desbloquea
// después (N1); la dirección abreviada no se corta de renglón (N9).
import { describe, expect, it, vi } from 'vitest';
import wordlistText from '../vendor/mtw-wordlist-v1.txt?raw';
import { keysForEnvelope, openEnvelope, parseEnvelope, serializeEnvelope } from '../crypto/envelope.ts';
import type { Argon2 } from '../crypto/kdf.ts';
import { addressOf, isValidPrivateKey } from '../crypto/keys.ts';
import { parseWordlist } from '../crypto/wordlist.ts';
import { deriveArgon2id } from '../workers/argon2-protocol.ts';
import { ApiError, NetworkError } from '../api/problem.ts';
import type { PlatformAuth } from '../api/request-signature.ts';
import { generateSessionKey } from '../api/session-key.ts';
import type { WalletApi } from '../api/wallet-api.ts';
import { startLogin } from '../unlock/opaque.ts';
import { opaqueTestServer, opaqueUnlockApi } from '../unlock/opaque-server.test-helper.ts';
import { unlockWallet } from '../unlock/unlock.ts';
import { envelopeFileName } from '../ui/download.ts';
import {
  draftUserKey,
  hasIndependentBackup,
  LOST_U_AND_R_WARNING,
  ONBOARDING_KEY_VERSION,
  passwordUPaperText,
  registerNewUserKey,
  sealUserKey,
  shortAddress,
  uQrTitle,
  userKeyMemoryKiB,
  uWordsHandwritten,
  uWordsTitle,
} from './user-key.ts';

const wordlist = parseWordlist(wordlistText);
const argon2: Argon2 = (input) => deriveArgon2id(input);
const WALLET = '0b6b3c1e-2f3a-4c5d-8e9f-0a1b2c3d4e5f';
/** Un error de la plataforma con su status y código (sin texto propio: la app no lo muestra). */
const problem = (status: number, code: string) =>
  new ApiError({ type: 'about:blank', title: 'Error', status, code, requestId: 't' }, status === 429 ? 2 : null);

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

  it('un intento que falla (red, 5xx o 429) se reintenta con el mismo AuthSecret_U y después la Password U desbloquea (N1)', async () => {
    const failures: [string, () => Error, 'opaque' | 'register'][] = [
      ['red', () => new NetworkError('No se pudo contactar a la plataforma'), 'opaque'],
      ['5xx (el registro llegó y la respuesta no)', () => problem(503, 'SERVICE_UNAVAILABLE'), 'register'],
      ['429', () => problem(429, 'RATE_LIMITED'), 'register'],
    ];
    for (const [name, failure, step] of failures) {
      const server = opaqueTestServer();
      const draft = draftUserKey(wordlist);
      const password = draft.passwordWords.join(' ');
      const sealed = await sealUserKey(
        draft,
        password,
        { platformId: 'mt-test', walletId: WALLET, keyVersion: 1 },
        argon2,
      );
      const secret = new Uint8Array(sealed.authSecret);
      const platform: PlatformAuth = { token: 'jws', sessionId: crypto.randomUUID(), key: await generateSessionKey() };
      let attempts = 0;
      const api = {
        userKeyOpaqueRegistration: vi.fn<WalletApi['userKeyOpaqueRegistration']>((_p, walletId, request) => {
          if (step === 'opaque' && attempts++ === 0) return Promise.reject(failure());
          return Promise.resolve({
            registrationResponse: server.registrationResponse(walletId, 1, request),
            keyVersion: 1,
          });
        }),
        registerUserKey: vi.fn<WalletApi['registerUserKey']>((_p, walletId, input) => {
          // Como el backend: el alta de la misma U reemplaza el registro anterior (también uno que ya había llegado).
          server.records.set(server.identifier(walletId, 1), input.registrationRecord);
          if (step === 'register' && attempts++ === 0) return Promise.reject(failure());
          return Promise.resolve({ userKey: input.userKey, keyVersion: 1, status: 'PENDING' as const });
        }),
      };
      const flags = { drive: false, file: true, qr: false, words: false };
      await expect(registerNewUserKey(api as unknown as WalletApi, platform, sealed, flags), name).rejects.toThrow();
      // El intento fallido no tocó el original: el reintento registra con el mismo secreto.
      expect([...sealed.authSecret], name).toEqual([...secret]);
      expect(await registerNewUserKey(api as unknown as WalletApi, platform, sealed, flags), name).toEqual({
        userKey: draft.address,
        keyVersion: 1,
        status: 'PENDING',
      });
      expect(
        sealed.authSecret.every((b) => b === 0),
        name,
      ).toBe(true);
      // El desbloqueo con la Password U correcta, contra el registro que quedó (el del reintento).
      const unlocked = await unlockWallet(
        opaqueUnlockApi(server) as unknown as WalletApi,
        sealed.envelope,
        password,
        argon2,
      );
      expect(unlocked.session.scope, name).toBe('OPERATIONS');
    }
  });

  it('con U ya registrada, otro registro no sale con el AuthSecret_U borrado y el registro vigente sigue abriendo (N1)', async () => {
    const server = opaqueTestServer();
    const draft = draftUserKey(wordlist);
    const password = draft.passwordWords.join(' ');
    const sealed = await sealUserKey(
      draft,
      password,
      { platformId: 'mt-test', walletId: WALLET, keyVersion: 1 },
      argon2,
    );
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
    const flags = { drive: false, file: true, qr: false, words: false };
    await registerNewUserKey(api as unknown as WalletApi, platform, sealed, flags);
    // Un reintento por error (la pantalla ya no lo hace con U registrada) falla antes de hablar con la plataforma.
    await expect(registerNewUserKey(api as unknown as WalletApi, platform, sealed, flags)).rejects.toThrow(TypeError);
    expect(api.userKeyOpaqueRegistration).toHaveBeenCalledTimes(1);
    expect(api.registerUserKey).toHaveBeenCalledTimes(1);
    const unlocked = await unlockWallet(
      opaqueUnlockApi(server) as unknown as WalletApi,
      sealed.envelope,
      password,
      argon2,
    );
    expect(unlocked.session.scope).toBe('OPERATIONS');
  });

  it('[F-KEY-03] por defecto 64 MiB; con la opción avanzada para computadoras, 128 MiB y el sobre abre igual', async () => {
    expect(userKeyMemoryKiB(false)).toBe(65_536);
    expect(userKeyMemoryKiB(true)).toBe(131_072);
    const draft = draftUserKey(wordlist);
    const password = draft.passwordWords.join(' ');
    const sealed = await sealUserKey(
      draft,
      password,
      { platformId: 'mt-test', walletId: WALLET, keyVersion: ONBOARDING_KEY_VERSION },
      argon2,
      userKeyMemoryKiB(true),
    );
    expect(sealed.envelope.kdf).toMatchObject({ alg: 'argon2id', memoryKiB: 131_072, iterations: 3, parallelism: 4 });
    // El parámetro viaja en el sobre (y en el registro, que el backend acepta: 64 o 128 MiB).
    const reopened = parseEnvelope(JSON.parse(serializeEnvelope(sealed.envelope)));
    const keys = await keysForEnvelope(reopened, password, argon2);
    expect(addressOf(await openEnvelope(reopened, keys.encryptionKey))).toBe(draft.address);
  });

  it('el aviso de U y R perdidas a la vez dice la consecuencia y por qué se piden los backups', () => {
    expect(LOST_U_AND_R_WARNING).toContain('Tu Safe necesita 2 de sus 3 firmas.');
    // Cada raya pegada a su palabra con U+2060 (word joiner): no queda sola al final de un renglón (N9).
    expect(LOST_U_AND_R_WARNING).toContain('nadie —⁠tampoco MT Wallet⁠— puede mover tus fondos');
    expect(LOST_U_AND_R_WARNING.replaceAll('⁠', '')).toContain('nadie —tampoco MT Wallet— puede mover tus fondos');
    expect(LOST_U_AND_R_WARNING).toContain('con la clave de la plataforma sola no alcanza');
    expect(LOST_U_AND_R_WARNING).toContain('Por eso pedimos backups de las dos.');
  });

  it('hace falta un backup independiente de la plataforma (Drive solo no alcanza)', () => {
    expect(hasIndependentBackup({ drive: true, file: false, qr: false, words: false })).toBe(false);
    expect(hasIndependentBackup({ drive: false, file: true, qr: false, words: false })).toBe(true);
    expect(hasIndependentBackup({ drive: false, file: false, qr: true, words: false })).toBe(true);
    expect(hasIndependentBackup({ drive: false, file: false, qr: false, words: true })).toBe(true);
  });

  it('lo impreso (y lo anotado a mano) dice de qué app, de qué U (su dirección), qué parte y con qué se abre', () => {
    const U = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    // Con espacios que no cortan (U+00A0): el «0x» y el último grupo no quedan solos en otro renglón (N9).
    const short = '0x\u00a08335\u00a0…\u00a02913';
    expect(shortAddress(U)).toBe(short);
    expect(shortAddress(U.toLowerCase() as `0x${string}`)).toBe(short);
    expect(shortAddress(U)).not.toContain(' ');
    expect(uWordsTitle(U)).toBe(`MT Wallet: 17 palabras de tu clave U ${short}`);
    expect(uQrTitle(U, 1, 1)).toBe(
      `MT Wallet: QR del sobre de tu clave U ${short}, parte 1 de 1 (se abre con la Password U)`,
    );
    expect(uQrTitle(U, 2, 3)).toBe(
      `MT Wallet: QR del sobre de tu clave U ${short}, parte 2 de 3 (se abre con la Password U)`,
    );
    expect(uWordsHandwritten(U)).toBe(
      `Si las anotás a mano, escribí arriba de qué clave son, con su dirección: «MT Wallet: 17 palabras de tu clave U ${short}».`,
    );
    expect(passwordUPaperText(U)).toBe(`Arriba del papel escribí «MT Wallet: Password U de ${short}».`);
    // El archivo: el de U′ no baja con el mismo nombre que el de la U anterior (hallazgo 1 de la cuarta revisión).
    expect(envelopeFileName({ walletId: WALLET, keyAddress: U.toLowerCase() as `0x${string}` })).toBe(
      `mtw-U-${WALLET}-8335-2913.enc.json`,
    );
  });
});
