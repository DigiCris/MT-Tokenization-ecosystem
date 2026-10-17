// P10.SEC [B-PSES-02]: el servidor nunca recibe la Password U ni AuthSecret_U. Se recorre el registro OPAQUE y el
// desbloqueo por la API registrando cada byte que el cliente manda, y se revisan además los logs, la base y Valkey.
// OPAQUE_SERVER_SETUP en staging/producción sólo se lee de un archivo de secrets (`*_FILE`, ADR-030).
import * as opaque from '@serenity-kit/opaque';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.ts';
import { withTransaction } from '../../src/db/transaction.ts';
import { OPAQUE_KEY_STRETCHING } from '../../src/platform-session/opaque.ts';
import { signedInClient } from '../helpers/accounts.ts';
import { buildTestListener, testRedis, type TestListener } from '../helpers/api.ts';
import { localEnv, testConfig } from '../helpers/config.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { captureLogger, type CapturedLogger } from '../helpers/logs.ts';
import { checkSession, seedActiveWallet, unlockWallet } from '../helpers/platform.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let db: TestDatabase;
let listener: TestListener;
let logs: CapturedLogger;

beforeAll(async () => {
  db = await createTestDatabase();
  logs = captureLogger('debug');
  const redis = testRedis(REDIS_DBS.platformSecurity);
  await redis.flushdb();
  listener = await buildTestListener({
    db,
    redis,
    logger: logs.logger,
    config: testConfig({ RATE_LIMIT_GLOBAL_PER_MINUTE: '100000' }),
  });
});
afterAll(async () => {
  await listener.close();
  await listener.redis.quit();
  await db.close();
});

describe('la Password U y AuthSecret_U nunca llegan al servidor', () => {
  it('registro OPAQUE y desbloqueo: ni en los requests, ni en los logs, ni en la base, ni en Valkey', async () => {
    const passwordU = `password U de prueba ${crypto.randomUUID()}`;
    // En el navegador: AuthSecret_U = HKDF(Argon2id(Password U)); acá alcanza con un valor derivado y único.
    const authSecret = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(passwordU))).toString(
      'hex',
    );
    const { client: browser, account } = await signedInClient(listener, db);
    const { walletId } = await seedActiveWallet(db, { userId: account.id, platformId: listener.config.platformId });

    // Registro: lo único que cruza la red son el registrationRequest y el registrationRecord.
    const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password: authSecret });
    const registrationResponse = listener.services.opaque.registrationResponse({
      walletId,
      keyVersion: 1,
      registrationRequest,
    });
    const { registrationRecord } = opaque.client.finishRegistration({
      clientRegistrationState,
      registrationResponse,
      password: authSecret,
      keyStretching: OPAQUE_KEY_STRETCHING,
    });
    const sentToServer = [registrationRequest, registrationRecord];
    await withTransaction(db.app, async (trx) => {
      await listener.services.opaque.storeRegistration(trx, {
        userId: account.id,
        walletId,
        keyVersion: 1,
        registrationRecord,
      });
      await listener.services.opaque.activate(trx, { walletId, keyVersion: 1 });
    });

    const unlocked = await unlockWallet(browser, authSecret);
    expect((await checkSession(browser, unlocked)).statusCode).toBe(200);

    const forbidden = [
      authSecret,
      passwordU,
      Buffer.from(authSecret, 'hex').toString('base64'),
      Buffer.from(authSecret, 'hex').toString('base64url'),
    ];
    const wire = JSON.stringify([...browser.sent, ...sentToServer]);
    for (const value of forbidden) expect(wire).not.toContain(value);
    expect(browser.sent.some((r) => r.url.endsWith('/opaque/start'))).toBe(true);
    expect(browser.sent.some((r) => r.url.endsWith('/opaque/finish'))).toBe(true);

    const output = logs.output();
    for (const value of forbidden) expect(output).not.toContain(value);
    expect(output).not.toContain(unlocked.token);

    const dumps = await db.admin.query<{ dump: string }>(
      `SELECT row_to_json(t)::text AS dump FROM (
         SELECT * FROM opaque_records WHERE user_id = $1
       ) t
       UNION ALL SELECT row_to_json(p)::text FROM platform_sessions p WHERE user_id = $1
       UNION ALL SELECT row_to_json(a)::text FROM audit_events a WHERE user_id = $1`,
      [account.id],
    );
    for (const row of dumps.rows) {
      for (const value of forbidden) expect(row.dump).not.toContain(value);
      expect(row.dump).not.toContain(unlocked.token);
    }
    for (const key of await listener.redis.keys('*')) {
      const type = await listener.redis.type(key);
      const value =
        type === 'string'
          ? await listener.redis.get(key)
          : JSON.stringify(type === 'hash' ? await listener.redis.hgetall(key) : []);
      for (const secret of forbidden) expect(String(value)).not.toContain(secret);
    }
  });
});

describe('OPAQUE_SERVER_SETUP', () => {
  it('en staging y producción sólo se acepta desde un archivo de secrets (*_FILE)', () => {
    for (const appEnv of ['staging', 'production']) {
      try {
        loadConfig({ env: { ...localEnv(), APP_ENV: appEnv }, envFile: null });
        throw new Error('debía fallar');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).problems).toContain(
          `OPAQUE_SERVER_SETUP: en ${appEnv} los secretos se leen sólo de OPAQUE_SERVER_SETUP_FILE (ADR-030)`,
        );
      }
    }
  });

  it('nunca se serializa ni aparece en la inspección de la configuración', () => {
    const env = localEnv();
    const config = loadConfig({ env, envFile: null });
    const setup = env.OPAQUE_SERVER_SETUP ?? '';
    expect(setup.length).toBe(171);
    expect(JSON.stringify(config)).not.toContain(setup);
    expect(String(config.secrets.opaqueServerSetup)).toBe('[REDACTED]');
  });
});
