// P15.T07: bandeja in-app ([B-API] grupo `notifications`, en los dos listeners) y los eventos de cuenta de [B-MAIL-03]
// (nuevo login y reset de password) con email + notificación en la misma transacción. Paginación por cursor, filtro de
// no leídas, marca de leída idempotente y [B-AUTHZ] (una notificación de otro usuario responde 404).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notify } from '../../src/notifications/notify.ts';
import type { NotificationView } from '../../src/notifications/service.ts';
import { startAccountEnv, type AccountEnv } from '../helpers/account-env.ts';
import { randomPassword, signedInClient } from '../helpers/accounts.ts';
import { resetTokenFrom, waitForMessage } from '../helpers/mailpit.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

interface Page {
  items: NotificationView[];
  unread: number;
  nextCursor: string | null;
}

let env: AccountEnv;

beforeAll(async () => {
  env = await startAccountEnv({ redisDb: REDIS_DBS.notificationsApi });
});

afterAll(async () => {
  await env.close();
});

describe('eventos de cuenta de [B-MAIL-03]', () => {
  it('nuevo login (Wallet y Recovery): email y NEW_LOGIN en la misma bandeja de las dos apps', async () => {
    const { client, account } = await signedInClient(env.wallet, env.db);
    await waitForMessage(account.email, (m) => m.subject.includes('Nuevo inicio de sesión'));
    const recovery = env.recovery.newClient();
    const login = await recovery.post('/api/v1/auth/login', { email: account.email, password: account.password });
    expect(login.statusCode).toBe(200);
    for (const browser of [client, recovery]) {
      const page = (await browser.get('/api/v1/notifications')).json<Page>();
      expect(page.items.map((n) => [n.type, n.payload.app])).toEqual([
        ['NEW_LOGIN', 'RECOVERY'],
        ['NEW_LOGIN', 'WALLET'],
      ]);
      expect(page.unread).toBe(2);
    }
  });

  it('reset de password: email y PASSWORD_RESET_COMPLETED con las sesiones revocadas', async () => {
    const { account } = await signedInClient(env.wallet, env.db);
    const forgot = await env.wallet.newClient().post('/api/v1/auth/forgot-password', { email: account.email });
    expect(forgot.statusCode).toBe(202);
    const token = resetTokenFrom(
      await waitForMessage(account.email, (m) => m.subject.includes('Restablecé tu contraseña')),
    );
    const newPassword = randomPassword();
    const reset = await env.wallet.newClient().post('/api/v1/auth/reset-password', { token, newPassword });
    expect(reset.statusCode).toBe(204);
    await waitForMessage(account.email, (m) => m.subject.includes('Tu contraseña cambió'));
    const browser = env.wallet.newClient();
    expect((await browser.post('/api/v1/auth/login', { email: account.email, password: newPassword })).statusCode).toBe(
      200,
    );
    const page = (await browser.get('/api/v1/notifications')).json<Page>();
    expect(page.items.map((n) => n.type)).toEqual(['NEW_LOGIN', 'PASSWORD_RESET_COMPLETED', 'NEW_LOGIN']);
    expect(page.items[1]?.payload).toMatchObject({ app: 'WALLET', revokedSessions: 1 });
  });
});

describe('bandeja in-app', () => {
  it('paginación por cursor, no leídas, marca idempotente; la de otro usuario → 404; sin sesión → 401', async () => {
    const { client, account } = await signedInClient(env.wallet, env.db);
    await env.db.app.transaction().execute(async (trx) => {
      for (let i = 0; i < 24; i++) {
        await notify(trx, { userId: account.id, walletId: null, type: 'TEST_EVENT', payload: { i } });
      }
    });
    const first = (await client.get('/api/v1/notifications?limit=10')).json<Page>();
    expect(first.items).toHaveLength(10);
    expect(first.unread).toBe(25);
    expect(first.nextCursor).toBe(first.items[9]?.id);
    const second = (await client.get(`/api/v1/notifications?limit=10&before=${first.nextCursor ?? ''}`)).json<Page>();
    expect(second.items).toHaveLength(10);
    const third = (await client.get(`/api/v1/notifications?limit=10&before=${second.nextCursor ?? ''}`)).json<Page>();
    expect(third.items).toHaveLength(5);
    expect(third.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items, ...third.items].map((n) => n.id);
    expect(new Set(ids).size).toBe(25);

    const target = first.items[0]?.id ?? '';
    const read = await client.post(`/api/v1/notifications/${target}/read`, {});
    expect(read.statusCode).toBe(200);
    const readAt = read.json<NotificationView>().readAt;
    expect(readAt).not.toBeNull();
    const again = await client.post(`/api/v1/notifications/${target}/read`, {});
    expect(again.json<NotificationView>().readAt).toBe(readAt);
    const unread = (await client.get('/api/v1/notifications?unread=true&limit=100')).json<Page>();
    expect(unread.unread).toBe(24);
    expect(unread.items.map((n) => n.id)).not.toContain(target);

    const other = await signedInClient(env.recovery, env.db);
    expect((await other.client.post(`/api/v1/notifications/${target}/read`, {})).statusCode).toBe(404);
    expect((await other.client.get(`/api/v1/notifications?before=${target}`)).statusCode).toBe(404);
    expect((await env.wallet.newClient().get('/api/v1/notifications')).statusCode).toBe(401);
    // CSRF: la marca de leída es un POST de cuenta.
    expect(
      (await client.post(`/api/v1/notifications/${target}/read`, {}, { 'x-csrf-token': 'adulterado' })).statusCode,
    ).toBe(403);
  });
});
