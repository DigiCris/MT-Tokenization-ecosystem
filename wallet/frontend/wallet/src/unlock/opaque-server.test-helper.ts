// Servidor OPAQUE en proceso para los tests unitarios del cliente: la misma librería y los mismos parámetros que el
// backend (userIdentifier `mtw:<plataforma>:<wallet>:<versión>`, binding HMAC de [B-PSES-02]), sin red. Los tests
// contra el backend real están en test/browser/stack.
import * as opaque from '@serenity-kit/opaque';
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
