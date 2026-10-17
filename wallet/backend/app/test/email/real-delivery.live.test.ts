// P09.TST.h: entrega real de punta a punta. La API real registra, verifica, restablece y desbloquea la cuenta de
// EMAIL_TEST_ADDRESS; el worker real envía cada email por Mailgun (dominio sandbox, remitente
// no-reply@<EMAIL_PROVIDER_DOMAIN>) y el test lee cada código o link con la Gmail API (búsqueda por el Message-ID del
// envío, incluyendo spam y papelera) para completar el flujo. Sin mocks y sin códigos, tokens ni credenciales en logs.
// Si Gmail rechaza un envío por la alineación DMARC del sandbox compartido (helpers/mailgun-live.ts), el test hace lo
// que haría el usuario: pide el reenvío por la API (acotado por los rate limits reales).
import { setTimeout as sleep } from 'node:timers/promises';
import type { LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RATE_LIMIT_NAMESPACE, type RateLimitPolicyName } from '../../src/api/plugins/rate-limit.ts';
import { MailgunProvider } from '../../src/email/mailgun.ts';
import type { TemplateName } from '../../src/email/templates.ts';
import { randomPassword } from '../helpers/accounts.ts';
import { startAccountEnv, type AccountEnv } from '../helpers/account-env.ts';
import type { TestClient } from '../helpers/client.ts';
import { GmailReader, type GmailMessage } from '../helpers/gmail.ts';
import { gmailLiveEnv, mailgunLiveEnv } from '../helpers/live-env.ts';
import { captureLogger, type CapturedLogger } from '../helpers/logs.ts';
import {
  assertQuotaWindow,
  describeFailure,
  EMAIL_RETRY_WINDOW_MS,
  eventsOrRetry,
  isSandboxDmarcRejection,
  SANDBOX_MAX_SENDS,
} from '../helpers/mailgun-live.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

const mailgun = mailgunLiveEnv();
const gmailEnv = gmailLiveEnv();
const address = gmailEnv.address;
const provider = new MailgunProvider(mailgun);
const gmail = new GmailReader(gmailEnv);

let env: AccountEnv;
let logs: CapturedLogger;
/** Valores sensibles vistos durante el test: nunca deben aparecer en los logs. */
const secrets = new Set<string>();

beforeAll(async () => {
  expect(await gmail.profileAddress()).toBe(address);
  logs = captureLogger('debug');
  env = await startAccountEnv({ redisDb: REDIS_DBS.realDeliveryLive, provider, logger: logs.logger });
});
afterAll(async () => {
  await env.close();
});

async function latestReference(template: TemplateName, since: Date): Promise<string | undefined> {
  const row = await env.db.app
    .selectFrom('outbox_events')
    .select('aggregate_id')
    .where('aggregate_type', '=', 'email')
    .where(sql<string>`payload->>'template'`, '=', template)
    .where(sql<string>`payload->>'to'`, '=', address)
    .where('created_at', '>=', since)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row?.aggregate_id;
}

/**
 * Libera los buckets de una política de [B-RL] en el Valkey propio de este archivo. Sólo se usa después de que Gmail
 * rechazó por DMARC los envíos anteriores: equivale a que pase la ventana (hasta 1 h en el olvido de contraseña) para
 * que el reintento del usuario no espere. Los rate limits se prueban de verdad en test/security/bruteforce-totp.test.ts.
 */
async function releaseRateLimit(policy: RateLimitPolicyName): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await env.redis.scan(
      cursor,
      'MATCH',
      `${RATE_LIMIT_NAMESPACE}policy:${policy}:*`,
      'COUNT',
      500,
    );
    if (keys.length > 0) await env.redis.del(...keys);
    cursor = next;
  } while (cursor !== '0');
}

/**
 * Dispara el envío (`trigger(intento)`), espera el email en Gmail por su Message-ID y, si Gmail lo rechazó por DMARC
 * del sandbox, vuelve a dispararlo como lo haría el usuario.
 */
async function receive(
  template: TemplateName,
  policy: RateLimitPolicyName,
  trigger: (attempt: number) => Promise<LightMyRequestResponse>,
): Promise<GmailMessage> {
  for (let attempt = 1; attempt <= SANDBOX_MAX_SENDS; attempt++) {
    const since = new Date(Date.now() - 1_000);
    let response = await trigger(attempt);
    if (response.statusCode === 429 && attempt > 1) {
      await releaseRateLimit(policy);
      response = await trigger(attempt);
    }
    expect(response.statusCode).toBe(202);
    let reference: string | undefined;
    for (let i = 0; i < 100 && reference === undefined; i++) {
      reference = await latestReference(template, since);
      if (reference === undefined) await sleep(100);
    }
    if (reference === undefined) throw new Error(`la API no encoló el email ${template}`);
    const messageId = `${reference}@${mailgun.domain}`;
    // El worker reintenta los rechazos momentáneos de Mailgun (429/5xx) durante EMAIL_RETRY_WINDOW_MS: hasta que
    // Mailgun acepta el envío, el plazo es esa ventana; desde la aceptación, 5 min para que Gmail lo reciba.
    const enqueuedAt = Date.now();
    let acceptedAt: number | undefined;
    for (;;) {
      const [id] = await gmail.list(`rfc822msgid:${messageId}`);
      if (id) {
        const message = await gmail.message(id);
        expect(message.headers['x-mtw-ref']).toBe(reference);
        return message;
      }
      const events = await eventsOrRetry(provider, { messageId });
      if (acceptedAt === undefined && events.some((e) => e.event === 'accepted')) acceptedAt = Date.now();
      const failed = events.find((e) => e.event === 'failed' && e.severity === 'permanent');
      if (failed) {
        if (!isSandboxDmarcRejection(failed))
          throw new Error(`${template}: falla permanente ${describeFailure(failed)}`);
        break;
      }
      if (acceptedAt === undefined) {
        // Si el worker ya recibió un 429 con fecha posterior a su ventana de reintentos (cuota diaria), falla ya.
        const throttled = logs
          .lines()
          .find((l) => l.msg === 'email no enviado' && l.reference === reference && typeof l.retryAfter === 'string');
        if (typeof throttled?.retryAfter === 'string') {
          assertQuotaWindow(new Date(throttled.retryAfter), enqueuedAt + EMAIL_RETRY_WINDOW_MS - Date.now());
        }
        if (Date.now() > enqueuedAt + EMAIL_RETRY_WINDOW_MS + 60_000)
          throw new Error(`${template}: Mailgun no aceptó el envío en toda la ventana de reintentos (${messageId})`);
      }
      if (acceptedAt !== undefined && Date.now() > acceptedAt + 300_000)
        throw new Error(`${template}: no llegó a Gmail (${messageId})`);
      await sleep(5_000);
    }
  }
  throw new Error(`${template}: Gmail rechazó por DMARC todos los envíos`);
}

function codeOf(message: GmailMessage): string {
  const code = /Código: (\d{8})/.exec(message.text)?.[1];
  if (!code) throw new Error('el email no trae un código de 8 dígitos');
  secrets.add(code);
  return code;
}

describe('entrega real por Mailgun leída con la Gmail API', () => {
  const password = randomPassword();
  const newPassword = randomPassword();
  let browser: TestClient;

  it('registro → código de verificación leído en Gmail → verificación con sesión', { timeout: 2_400_000 }, async () => {
    secrets.add(password).add(newPassword);
    browser = env.wallet.newClient();
    const message = await receive('email-verification', 'otp-challenge', (attempt) =>
      attempt === 1
        ? browser.post('/api/v1/auth/register', { email: address, password })
        : browser.post('/api/v1/auth/verify-email/resend', { email: address }),
    );
    expect(message.headers.from).toContain(`no-reply@${mailgun.domain}`);
    expect(message.subject).toBe('[MTW local] Verificá tu email');
    expect(message.text).toContain('Acción: Verificación de email de la cuenta');
    const verified = await browser.post('/api/v1/auth/verify-email', { email: address, code: codeOf(message) });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ user: { email: address, emailVerified: true } });
    expect((await browser.get('/api/v1/users/me')).statusCode).toBe(200);
  });

  it(
    'olvido → link de reset leído en Gmail → contraseña nueva, sesiones cerradas y login',
    { timeout: 2_400_000 },
    async () => {
      const message = await receive('password-reset', 'forgot-password', () =>
        env.wallet.newClient().post('/api/v1/auth/forgot-password', { email: address }),
      );
      expect(message.subject).toBe('[MTW local] Restablecé tu contraseña');
      const token = /#token=([0-9a-f-]{36}\.[A-Za-z0-9_-]{43})/.exec(message.text)?.[1];
      if (!token) throw new Error('el email no trae el link de reset');
      secrets.add(token);
      expect(message.text).toContain(`${env.wallet.origin}/reset-password#token=${token}`);

      const reset = await env.wallet.newClient().post('/api/v1/auth/reset-password', { token, newPassword });
      expect(reset.statusCode).toBe(204);
      expect((await browser.get('/api/v1/users/me')).statusCode).toBe(401);
      const login = await env.wallet.newClient().post('/api/v1/auth/login', { email: address, password: newPassword });
      expect(login.statusCode).toBe(200);
    },
  );

  it(
    'cuenta bloqueada → código de desbloqueo leído en Gmail → desbloqueo y login',
    { timeout: 2_700_000 },
    async () => {
      await env.db.app.updateTable('users').set({ status: 'LOCKED' }).where('email', '=', address).execute();
      let lastRequest = 0;
      const message = await receive('login-unlock', 'otp-challenge', async (attempt) => {
        // El pedido de desbloqueo no genera otro código dentro de los 2 minutos del anterior (anti-inundación): se espera.
        if (attempt > 1) await sleep(Math.max(0, lastRequest + 125_000 - Date.now()));
        lastRequest = Date.now();
        return env.wallet.newClient().post('/api/v1/auth/unlock/request', { email: address });
      });
      expect(message.subject).toBe('[MTW local] Desbloqueá tu cuenta');
      const unlocked = await env.wallet
        .newClient()
        .post('/api/v1/auth/unlock', { email: address, code: codeOf(message) });
      expect(unlocked.statusCode).toBe(204);
      expect(
        (await env.wallet.newClient().post('/api/v1/auth/login', { email: address, password: newPassword })).statusCode,
      ).toBe(200);
    },
  );

  it('ningún código, token, contraseña ni credencial aparece en los logs', () => {
    const output = logs.output();
    expect(output).toContain('email enviado');
    for (const value of [
      ...secrets,
      mailgun.apiKey.reveal(),
      gmailEnv.clientSecret.reveal(),
      gmailEnv.refreshToken.reveal(),
    ]) {
      // Los códigos son números: se buscan como número completo (no dentro de un timestamp).
      const pattern = /^\d+$/.test(value) ? new RegExp(`(?<!\\d)${value}(?!\\d)`) : null;
      expect(pattern ? pattern.test(output) : output.includes(value)).toBe(false);
    }
  });
});
