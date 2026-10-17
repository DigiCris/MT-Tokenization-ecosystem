// [B-OBS] Tests de canario (P08.T07, P08.SEC): valores secretos sembrados en logs directos, en requests reales
// (headers, body) y en errores nunca aparecen en la salida capturada del logger.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorResponses } from '../../src/api/errors.ts';
import { buildTestListener, type TestListener } from '../helpers/api.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { captureLogger, type CapturedLogger } from '../helpers/logs.ts';

const canary = (label: string) => `CANARY-${label}-${randomBytes(8).toString('hex')}`;

describe('logger directo', () => {
  it('nunca escribe valores sensibles, en ningún nivel', () => {
    const captured = captureLogger();
    const secrets = {
      password: canary('password'),
      passwordU: canary('passwordU'),
      otp: canary('otp'),
      privateKey: canary('pk'),
      mnemonic: canary('mnemonic'),
      registrationRecord: canary('opaque'),
      authorization: `Bearer ${canary('bearer')}`,
    };
    captured.logger.info({ user: { profile: secrets }, list: [secrets] }, 'evento con datos sensibles');
    captured.logger.error(
      { err: new Error(`fallo conectando a postgres://mtw_app:${secrets.password}@db/x`) },
      'error',
    );
    captured.logger.warn(`mensaje libre con redis://:${secrets.otp}@valkey:6379 y Bearer ${secrets.privateKey}`);
    const output = captured.output();
    for (const value of Object.values(secrets)) expect(output).not.toContain(value.replace('Bearer ', ''));
    expect(output).toContain('[REDACTED]');
  });
});

describe('logs de requests reales', () => {
  let db: TestDatabase;
  let captured: CapturedLogger;
  let listener: TestListener;
  const secretInError = canary('error');

  beforeAll(async () => {
    db = await createTestDatabase();
    captured = captureLogger('info');
    listener = await buildTestListener({
      db,
      logger: captured.logger,
      extraRoutes: (app) => {
        app.post(
          '/test/canary',
          {
            schema: {
              operationId: 'testCanary',
              tags: ['test'],
              summary: 'Ruta de prueba que loguea el body recibido',
              body: z.object({
                email: z.string(),
                password: z.string(),
                otp: z.string(),
                nested: z.object({ token: z.string() }),
              }),
              response: { 200: z.object({ ok: z.boolean() }), ...errorResponses() },
            },
          },
          (request) => {
            request.log.info({ body: request.body, headers: request.headers }, 'body recibido');
            return { ok: true };
          },
        );
        app.get(
          '/test/boom',
          {
            schema: {
              operationId: 'testBoom',
              tags: ['test'],
              summary: 'Ruta de prueba que falla con un error interno',
              response: { 200: z.object({ ok: z.boolean() }), ...errorResponses() },
            },
          },
          () => {
            throw new Error(`driver: postgres://mtw_app:${secretInError}@db:5432/mtw_wallet rechazó la conexión`);
          },
        );
      },
    });
  });

  afterAll(async () => {
    await listener.close();
    await db.close();
  });

  it('headers sensibles y campos del body no aparecen en ninguna línea', async () => {
    const values = {
      cookie: canary('cookie'),
      authorization: canary('authz'),
      platformSession: canary('ps'),
      sessionSignature: canary('sig'),
      csrf: canary('csrf'),
      password: canary('pw'),
      otp: canary('otp'),
      token: canary('token'),
    };
    const response = await listener.app.inject({
      method: 'POST',
      url: '/api/v1/test/canary',
      headers: {
        cookie: `__Host-mtw_sid=${values.cookie}`,
        authorization: `Bearer ${values.authorization}`,
        'x-platform-session': values.platformSession,
        'x-session-signature': values.sessionSignature,
        'x-csrf-token': values.csrf,
        'content-type': 'application/json',
      },
      payload: {
        email: 'ana.perez@dominio.com',
        password: values.password,
        otp: values.otp,
        nested: { token: values.token },
      },
    });
    expect(response.statusCode).toBe(200);
    const output = captured.output();
    for (const value of Object.values(values)) expect(output).not.toContain(value);
    expect(output).not.toContain('ana.perez@dominio.com');
    expect(output).toContain('a***@dominio.com');
    const completed = captured.lines().find((l) => l.msg === 'request completado');
    expect(completed?.req).toMatchObject({ method: 'POST', url: '/api/v1/test/canary' });
    expect(JSON.stringify(completed?.req)).not.toContain('headers');
  });

  it('los errores internos se loguean sin credenciales y el cliente no recibe detalles', async () => {
    const response = await listener.app.inject({ method: 'GET', url: '/api/v1/test/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
    expect(response.body).not.toContain('postgres://');
    expect(captured.output()).not.toContain(secretInError);
    expect(captured.output()).toContain('postgres://mtw_app:[REDACTED]@db:5432/mtw_wallet');
  });
});
