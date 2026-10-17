// P11.SEC: la redacción del logger del signer es una segunda barrera: campos sensibles, URLs con credenciales, Bearer y
// JWS compactos nunca llegan a la salida aunque se los pase por error.
import { describe, expect, it } from 'vitest';
import { captureLogger } from '../helpers/logs.ts';

const jsonPart = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('redacción de logs del signer', () => {
  it('oculta campos sensibles en profundidad y limpia credenciales en texto', () => {
    const logs = captureLogger();
    const canaries = {
      privateKey: `0x${'ab'.repeat(32)}`,
      credential: 'cd'.repeat(32),
      password: 'una-contraseña-derivada',
      // JWS compacto armado en runtime (un literal con forma de token lo bloquean gitleaks y el push protection).
      platformSessionToken: [
        jsonPart({ alg: 'EdDSA', typ: 'JWT' }),
        jsonPart({ sub: 'canario', aud: 'mtw-signer' }),
        'c2lnbmF0dXJh',
      ].join('.'),
    };
    logs.logger.info(
      { request: { ...canaries, nested: { secret: 'shh-canario', keystore: { ciphertext: 'ef'.repeat(32) } } } },
      'pedido',
    );
    logs.logger.warn(
      `RPC postgres://mtw_signer:supersecreto@db:5432/x Bearer abc.def ${canaries.platformSessionToken}`,
    );
    logs.logger.error(new Error(`fallo con ${canaries.platformSessionToken}`));
    const output = logs.output();
    for (const value of [...Object.values(canaries), 'shh-canario', 'ef'.repeat(32), 'supersecreto']) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain('[redactado]');
  });
});
