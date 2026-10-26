// Servidor OPAQUE en proceso para los tests unitarios del cliente: la misma librería y los mismos parámetros que el
// backend (userIdentifier `mtw:<plataforma>:<wallet>:<versión>`, binding HMAC de [B-PSES-02]), sin red, y la API de
// desbloqueo respaldada por él (para comprobar que una Password U registrada desbloquea). Los tests contra el backend
// real están en test/browser/stack.
import * as opaque from '@serenity-kit/opaque';
import { jwkThumbprint } from '../api/session-key.ts';
import type { IssuedPlatformSession, WalletApi } from '../api/wallet-api.ts';
import { fromBase64Url, ownBuffer, toBase64Url, utf8 } from '../crypto/bytes.ts';

await opaque.ready;

export interface OpaqueTestServer {
  setup: string;
  records: Map<string, string>;
  identifier: (walletId: string, keyVersion: number) => string;
  registrationResponse: (walletId: string, keyVersion: number, registrationRequest: string) => string;
  startLogin: (
    walletId: string,
    keyVersion: number,
    startLoginRequest: string,
  ) => { loginResponse: string; finish: (finishLoginRequest: string) => string };
}

export function opaqueTestServer(platformId = 'mt-test'): OpaqueTestServer {
  const setup = opaque.server.createSetup();
  const records = new Map<string, string>();
  const identifier = (walletId: string, keyVersion: number) => `mtw:${platformId}:${walletId}:${String(keyVersion)}`;
  return {
    setup,
    records,
    identifier,
    registrationResponse: (walletId, keyVersion, registrationRequest) =>
      opaque.server.createRegistrationResponse({
        serverSetup: setup,
        userIdentifier: identifier(walletId, keyVersion),
        registrationRequest,
      }).registrationResponse,
    startLogin: (walletId, keyVersion, startLoginRequest) => {
      const registrationRecord = records.get(identifier(walletId, keyVersion));
      if (registrationRecord === undefined) throw new Error('sin registro OPAQUE');
      const { serverLoginState, loginResponse } = opaque.server.startLogin({
        serverSetup: setup,
        registrationRecord,
        startLoginRequest,
        userIdentifier: identifier(walletId, keyVersion),
      });
      return {
        loginResponse,
        finish: (finishLoginRequest) => opaque.server.finishLogin({ finishLoginRequest, serverLoginState }).sessionKey,
      };
    },
  };
}

/** Binding esperado por el backend: base64url(HMAC-SHA256(sessionKey, thumbprint ‖ loginAttemptId)). */
export async function expectedBinding(sessionKey: string, thumbprint: string, loginAttemptId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    ownBuffer(fromBase64Url(sessionKey)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toBase64Url(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, ownBuffer(utf8(`${thumbprint}${loginAttemptId}`)))),
  );
}

/**
 * API de desbloqueo (opaqueStart/opaqueFinish) respaldada por el servidor, como el backend: busca el registro de la
 * wallet y versión del pedido, verifica el binding de la session key y emite una PlatformSession OPERATIONS.
 */
export function opaqueUnlockApi(server: OpaqueTestServer, keyVersion = 1) {
  const pending = new Map<string, { finish: (r: string) => string; thumbprint: string; walletId: string }>();
  return {
    opaqueStart: async (input: Parameters<WalletApi['opaqueStart']>[0]) => {
      const walletId = input.walletId ?? '';
      const started = server.startLogin(walletId, keyVersion, input.startLoginRequest);
      const loginAttemptId = crypto.randomUUID();
      pending.set(loginAttemptId, {
        finish: started.finish,
        thumbprint: await jwkThumbprint(input.sessionPublicKey),
        walletId,
      });
      return {
        loginAttemptId,
        loginResponse: started.loginResponse,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    opaqueFinish: async (input: Parameters<WalletApi['opaqueFinish']>[0]): Promise<IssuedPlatformSession> => {
      const attempt = pending.get(input.loginAttemptId);
      if (!attempt) throw new Error('intento desconocido');
      const sessionKey = attempt.finish(input.finishLoginRequest);
      if (input.sessionKeyBinding !== (await expectedBinding(sessionKey, attempt.thumbprint, input.loginAttemptId))) {
        throw new Error('binding inválido');
      }
      return {
        token: 'jws.de.prueba',
        session: {
          id: crypto.randomUUID(),
          scope: 'OPERATIONS',
          authMethod: 'OPAQUE_U',
          walletId: attempt.walletId,
          safe: null,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      };
    },
  };
}
