// P17.T06 [F-SES-02]/[B-PSES-02]: el cliente OPAQUE de la app contra el servidor OPAQUE real de la librería (mismos
// parámetros que el backend): registro y login con AuthSecret_U en hex, mismo key stretching (si difiere, no abre), clave
// de sesión acordada y binding HMAC de la session key; el desbloqueo detecta la Password U equivocada contra el sobre
// sin iniciar OPAQUE y un registro que no corresponde al sobre. El recorrido contra el backend real: test/browser/stack.
import { describe, expect, it, vi } from 'vitest';
import envelopeVectors from '../../test/vectors/wire/envelope.json';
import { fromBase64Url, fromHex } from '../crypto/bytes.ts';
import { parseEnvelope, type KeyEnvelope } from '../crypto/envelope.ts';
import { hkdfBytes, type Argon2 } from '../crypto/kdf.ts';
import { deriveArgon2id } from '../workers/argon2-protocol.ts';
import type { WalletApi } from '../api/wallet-api.ts';
import { opaquePassword, registerOpaque, startLogin, startRegistration } from './opaque.ts';
import { opaqueTestServer, opaqueUnlockApi } from './opaque-server.test-helper.ts';
import { UnlockError, unlockWallet } from './unlock.ts';

const argon2: Argon2 = (input) => deriveArgon2id(input);
const vector = (
  envelopeVectors as unknown as { envelopes: { password: string; authSecretHex: string; envelope: unknown }[] }
).envelopes[0]!;
const envelope: KeyEnvelope = parseEnvelope(vector.envelope);

describe('cliente OPAQUE', () => {
  it('registro + login con el servidor real: misma clave de sesión; otra password no abre', async () => {
    const server = opaqueTestServer();
    const secret = fromHex(vector.authSecretHex);
    expect(opaquePassword(secret)).toBe(vector.authSecretHex.slice(2));
    const record = await registerOpaque(secret, (request) =>
      Promise.resolve({ registrationResponse: server.registrationResponse('w1', 1, request) }),
    );
    server.records.set(server.identifier('w1', 1), record);
    const login = await startLogin(secret);
    const started = server.startLogin('w1', 1, login.startLoginRequest);
    const finished = login.finish(started.loginResponse);
    expect(finished).not.toBeNull();
    expect(server.startLogin('w1', 1, login.startLoginRequest)).toBeDefined();
    expect(started.finish(finished?.finishLoginRequest ?? '')).toBe(finished?.sessionKey);

    const wrong = await startLogin(new Uint8Array(32).fill(7));
    expect(wrong.finish(server.startLogin('w1', 1, wrong.startLoginRequest).loginResponse)).toBeNull();
    expect(() => opaquePassword(new Uint8Array(16))).toThrow(TypeError);
  });

  it('un AuthSecret_U ya borrado (en cero) no se registra ni se usa para entrar (N1)', async () => {
    const erased = new Uint8Array(32);
    expect(() => opaquePassword(erased)).toThrow(TypeError);
    const serverResponse = vi.fn(() => Promise.resolve({ registrationResponse: '' }));
    await expect(registerOpaque(erased, serverResponse)).rejects.toThrow(TypeError);
    expect(serverResponse).not.toHaveBeenCalled();
    await expect(startLogin(erased)).rejects.toThrow(TypeError);
  });

  it('un registro para otro identificador (wallet o versión) no abre con esa password', async () => {
    const server = opaqueTestServer();
    const secret = fromHex(vector.authSecretHex);
    const start = await startRegistration(secret);
    server.records.set(
      server.identifier('w1', 2),
      start.finish(server.registrationResponse('w1', 1, start.registrationRequest)),
    );
    const login = await startLogin(secret);
    expect(login.finish(server.startLogin('w1', 2, login.startLoginRequest).loginResponse)).toBeNull();
  });
});

/** API de desbloqueo respaldada por el servidor OPAQUE real (como el backend): verifica el binding de la session key. */
function unlockApi(server: ReturnType<typeof opaqueTestServer>, keyVersion = 1) {
  const backed = opaqueUnlockApi(server, keyVersion);
  return {
    opaqueStart: vi.fn<WalletApi['opaqueStart']>(backed.opaqueStart),
    opaqueFinish: vi.fn<WalletApi['opaqueFinish']>(backed.opaqueFinish),
  };
}

describe('desbloqueo', () => {
  it('sobre + Password U → OPAQUE con binding → PlatformSession; K_U y la session key no son exportables', async () => {
    const server = opaqueTestServer();
    const secret = await hkdfBytes(
      await argon2({
        password: new TextEncoder().encode(vector.password),
        salt: fromBase64Url(envelope.kdf.salt),
        memoryKiB: envelope.kdf.memoryKiB,
        iterations: envelope.kdf.iterations,
        parallelism: envelope.kdf.parallelism,
        outputLength: 32,
      }),
      'U-auth-v1',
    );
    const start = await startRegistration(secret);
    server.records.set(
      server.identifier(envelope.walletId, 1),
      start.finish(server.registrationResponse(envelope.walletId, 1, start.registrationRequest)),
    );
    const api = unlockApi(server);
    const unlocked = await unlockWallet(
      api as unknown as WalletApi,
      envelope,
      `  ${vector.password.toUpperCase()} `,
      argon2,
    );
    expect(unlocked.session.scope).toBe('OPERATIONS');
    expect(unlocked.encryptionKey.extractable).toBe(false);
    expect(unlocked.platform.key.privateKey.extractable).toBe(false);
    expect(api.opaqueStart).toHaveBeenCalledWith(expect.objectContaining({ walletId: envelope.walletId }));
  });

  it('Password U equivocada: falla contra el sobre sin iniciar OPAQUE; registro de otra password: RECORD_MISMATCH', async () => {
    const server = opaqueTestServer();
    const api = unlockApi(server);
    await expect(
      unlockWallet(api as unknown as WalletApi, envelope, 'una password que no es', argon2),
    ).rejects.toMatchObject({
      reason: 'WRONG_PASSWORD',
    });
    expect(api.opaqueStart).not.toHaveBeenCalled();

    const other = await startRegistration(new Uint8Array(32).fill(9));
    server.records.set(
      server.identifier(envelope.walletId, 1),
      other.finish(server.registrationResponse(envelope.walletId, 1, other.registrationRequest)),
    );
    const error = await unlockWallet(api as unknown as WalletApi, envelope, vector.password, argon2).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnlockError);
    expect(error).toMatchObject({ reason: 'RECORD_MISMATCH' });
    expect(api.opaqueFinish).not.toHaveBeenCalled();
  });
});
