// P10.T02 [B-PSES-02]: registro OPAQUE (cliente real @serenity-kit/opaque + servicio) ligado a (wallet, key_version):
// PENDING hasta que U se confirma on-chain, ACTIVE después (el ACTIVE anterior se retira); keyStretching fijo y
// versionado; un registro sólo abre su propia (wallet, versión) y el servidor nunca ve la entrada OPAQUE.
import * as opaque from '@serenity-kit/opaque';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/transaction.ts';
import { OPAQUE_KEY_STRETCHING, OpaqueProtocolError, opaqueUserIdentifier } from '../../src/platform-session/opaque.ts';
import { createVerifiedUser } from '../helpers/accounts.ts';
import { buildTestListener, testRedis, type TestListener } from '../helpers/api.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { newAuthSecret, registerOpaque, seedActiveWallet } from '../helpers/platform.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let db: TestDatabase;
let listener: TestListener;

beforeAll(async () => {
  db = await createTestDatabase();
  listener = await buildTestListener({ db, redis: testRedis(REDIS_DBS.opaqueRegistration) });
});
afterAll(async () => {
  await listener.close();
  await db.close();
});

async function records(walletId: string) {
  return db.app
    .selectFrom('opaque_records')
    .select(['id', 'key_version', 'status', 'activated_at', 'key_stretching', 'registration_record'])
    .where('wallet_id', '=', walletId)
    .orderBy('created_at')
    .execute();
}

/** Login OPAQUE completo del lado cliente contra un registro dado (servidor: librería directa). */
function loginAgainst(record: Buffer, identifier: string, authSecretHex: string): string | undefined {
  const setup = listener.config.secrets.opaqueServerSetup.reveal();
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password: authSecretHex });
  const { serverLoginState, loginResponse } = opaque.server.startLogin({
    serverSetup: setup,
    userIdentifier: identifier,
    registrationRecord: record.toString('base64url'),
    startLoginRequest,
  });
  const finished = opaque.client.finishLogin({
    clientLoginState,
    loginResponse,
    password: authSecretHex,
    keyStretching: OPAQUE_KEY_STRETCHING,
  });
  if (!finished) return undefined;
  return opaque.server.finishLogin({ finishLoginRequest: finished.finishLoginRequest, serverLoginState }).sessionKey;
}

describe('registro OPAQUE', () => {
  it('queda PENDING ligado a (wallet, versión) con el keyStretching versionado, y pasa a ACTIVE al confirmar U', async () => {
    const user = await createVerifiedUser(listener, db);
    const { walletId } = await seedActiveWallet(db, {
      userId: user.id,
      platformId: listener.config.platformId,
      status: 'CREATING',
    });
    const authSecret = newAuthSecret();
    await registerOpaque(listener, db, { userId: user.id, walletId, authSecretHex: authSecret, activate: false });
    const [pending] = await records(walletId);
    expect(pending).toMatchObject({ key_version: 1, status: 'PENDING', activated_at: null });
    expect(pending?.key_stretching).toEqual({
      version: 1,
      'argon2id-custom': { memory: 16384, iterations: 1, parallelism: 1 },
    });
    expect(pending?.registration_record).toHaveLength(192);

    await withTransaction(db.app, (trx) => listener.services.opaque.activate(trx, { walletId, keyVersion: 1 }));
    const [active] = await records(walletId);
    expect(active?.status).toBe('ACTIVE');
    expect(active?.activated_at).toBeInstanceOf(Date);
    const identifier = opaqueUserIdentifier(listener.config.platformId, walletId, 1);
    expect(loginAgainst(active?.registration_record ?? Buffer.alloc(0), identifier, authSecret)).toMatch(
      /^[A-Za-z0-9_-]{86}$/,
    );
  });

  it('un nuevo registro de la misma versión antes de activar reemplaza al PENDING anterior', async () => {
    const user = await createVerifiedUser(listener, db);
    const { walletId } = await seedActiveWallet(db, {
      userId: user.id,
      platformId: listener.config.platformId,
      status: 'CREATING',
    });
    await registerOpaque(listener, db, { userId: user.id, walletId, authSecretHex: newAuthSecret(), activate: false });
    const second = newAuthSecret();
    await registerOpaque(listener, db, { userId: user.id, walletId, authSecretHex: second, activate: false });
    const rows = await records(walletId);
    expect(rows.map((r) => r.status)).toEqual(['RETIRED', 'PENDING']);
  });

  it('rotar U (nueva versión) retira el registro ACTIVE anterior al activar el nuevo', async () => {
    const user = await createVerifiedUser(listener, db);
    const { walletId } = await seedActiveWallet(db, { userId: user.id, platformId: listener.config.platformId });
    const v1 = newAuthSecret();
    const v2 = newAuthSecret();
    await registerOpaque(listener, db, { userId: user.id, walletId, keyVersion: 1, authSecretHex: v1 });
    await registerOpaque(listener, db, {
      userId: user.id,
      walletId,
      keyVersion: 2,
      authSecretHex: v2,
      activate: false,
    });
    expect((await records(walletId)).map((r) => [r.key_version, r.status])).toEqual([
      [1, 'ACTIVE'],
      [2, 'PENDING'],
    ]);
    await withTransaction(db.app, (trx) => listener.services.opaque.activate(trx, { walletId, keyVersion: 2 }));
    expect((await records(walletId)).map((r) => [r.key_version, r.status])).toEqual([
      [1, 'RETIRED'],
      [2, 'ACTIVE'],
    ]);
  });

  it('el registro sólo abre su propia wallet y versión, y sólo con la misma entrada OPAQUE', async () => {
    const user = await createVerifiedUser(listener, db);
    const { walletId } = await seedActiveWallet(db, { userId: user.id, platformId: listener.config.platformId });
    const authSecret = newAuthSecret();
    await registerOpaque(listener, db, { userId: user.id, walletId, authSecretHex: authSecret });
    const record = (await records(walletId))[0]?.registration_record ?? Buffer.alloc(0);
    const platformId = listener.config.platformId;
    expect(loginAgainst(record, opaqueUserIdentifier(platformId, walletId, 1), authSecret)).toBeDefined();
    expect(loginAgainst(record, opaqueUserIdentifier(platformId, walletId, 1), newAuthSecret())).toBeUndefined();
    expect(loginAgainst(record, opaqueUserIdentifier(platformId, walletId, 2), authSecret)).toBeUndefined();
    expect(loginAgainst(record, opaqueUserIdentifier(platformId, crypto.randomUUID(), 1), authSecret)).toBeUndefined();
  });

  it('rechaza mensajes malformados y nunca persiste la entrada OPAQUE', async () => {
    const user = await createVerifiedUser(listener, db);
    const { walletId } = await seedActiveWallet(db, {
      userId: user.id,
      platformId: listener.config.platformId,
      status: 'CREATING',
    });
    expect(() =>
      listener.services.opaque.registrationResponse({ walletId, keyVersion: 1, registrationRequest: 'no-es-opaque' }),
    ).toThrow(OpaqueProtocolError);
    await expect(
      withTransaction(db.app, (trx) =>
        listener.services.opaque.storeRegistration(trx, {
          userId: user.id,
          walletId,
          keyVersion: 1,
          registrationRecord: Buffer.alloc(100).toString('base64url'),
        }),
      ),
    ).rejects.toThrow(OpaqueProtocolError);
    const authSecret = newAuthSecret();
    await registerOpaque(listener, db, { userId: user.id, walletId, authSecretHex: authSecret, activate: false });
    const { rows } = await db.admin.query<{ dump: string }>(
      'SELECT row_to_json(o)::text AS dump FROM opaque_records o WHERE wallet_id = $1',
      [walletId],
    );
    for (const row of rows) {
      expect(row.dump).not.toContain(authSecret);
      expect(row.dump.toLowerCase()).not.toContain(Buffer.from(authSecret, 'utf8').toString('hex'));
    }
    await expect(
      withTransaction(db.app, (trx) => listener.services.opaque.activate(trx, { walletId, keyVersion: 9 })),
    ).rejects.toThrow(/PENDING/);
  });
});
