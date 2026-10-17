// P09.T07 [B-MAIL-01]: envío por el outbox con el pipeline real (Postgres → dispatcher → BullMQ en Valkey → worker →
// SMTP de Mailpit). Parámetros sellados (ningún código en claro fuera del email), reintento ante una caída real del
// SMTP, rechazo definitivo (550) sin reintentos y códigos vencidos que no se envían.
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AppConfig } from '../../src/config/env.ts';
import { Secret } from '../../src/config/secret.ts';
import { OutboxRepository } from '../../src/db/repositories/outbox-repository.ts';
import { withTransaction } from '../../src/db/transaction.ts';
import { EmailOutbox, type EmailRequest } from '../../src/email/email-outbox.ts';
import { createEmailProvider } from '../../src/email/provider.ts';
import { MailgunProvider } from '../../src/email/mailgun.ts';
import { SmtpProvider } from '../../src/email/smtp.ts';
import type { TemplateName } from '../../src/email/templates.ts';
import { decryptField } from '../../src/lib/field-crypto.ts';
import { QUEUE_JOB_OPTIONS, QUEUES } from '../../src/queue/queues.ts';
import { testRedis } from '../helpers/api.ts';
import { testConfig } from '../helpers/config.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { startEmailPipeline, type EmailPipeline } from '../helpers/email-pipeline.ts';
import { TEMPLATE_FIXTURES } from '../helpers/email-fixtures.ts';
import { codeFrom, messagesTo, waitForMessage } from '../helpers/mailpit.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import { startTcpProxy, type TcpProxy } from '../helpers/tcp-proxy.ts';

let db: TestDatabase;
let config: AppConfig;
let emails: EmailOutbox;
let outbox: OutboxRepository;

const address = (label: string) => `${label}-${randomBytes(4).toString('hex')}@test.invalid`;

beforeAll(async () => {
  db = await createTestDatabase();
  config = testConfig();
  outbox = new OutboxRepository(db.app);
  emails = new EmailOutbox(outbox, config.secrets.fieldEncryptionKey);
  const redis = testRedis(REDIS_DBS.emailDelivery);
  await redis.flushdb();
  await redis.quit();
});
afterAll(async () => {
  await db.close();
});

async function enqueue<K extends TemplateName>(
  request: Omit<EmailRequest<K>, 'locale' | 'timeZone' | 'product'>,
): Promise<string> {
  return withTransaction(db.app, (trx) =>
    emails.enqueue(trx, { locale: 'es-AR', timeZone: 'America/Argentina/Buenos_Aires', product: 'Wallet', ...request }),
  );
}

async function outboxRow(reference: string) {
  return db.app.selectFrom('outbox_events').selectAll().where('aggregate_id', '=', reference).executeTakeFirstOrThrow();
}

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('tiempo de espera agotado');
    await sleep(100);
  }
}

describe('pipeline real hacia Mailpit', () => {
  let pipeline: EmailPipeline;

  beforeAll(async () => {
    pipeline = await startEmailPipeline({
      db: db.app,
      redisDb: REDIS_DBS.emailDelivery,
      fieldKey: config.secrets.fieldEncryptionKey,
    });
  });
  afterAll(async () => {
    await pipeline.stop();
  });

  it('entrega el email renderizado, con la referencia del envío, y confirma el evento del outbox', async () => {
    const to = address('entrega');
    const reference = await enqueue({
      to,
      template: 'email-verification',
      params: { ...TEMPLATE_FIXTURES['email-verification'], expiresAt: new Date(Date.now() + 900_000).toISOString() },
    });
    const message = await waitForMessage(to);
    expect(message.subject).toBe('[MTW local] Verificá tu email');
    expect(codeFrom(message)).toBe('48213907');
    expect(message.text).toContain('(America/Argentina/Buenos_Aires)');
    expect(message.headers['X-Mtw-Ref']).toEqual([reference]);
    expect(message.headers['Message-Id']).toEqual([`<${reference}@wallet.localhost>`]);
    expect(message.headers['X-Mtw-Tags']).toEqual(['mtw,email-verification']);
    expect(message.html).toContain('<strong>48213907</strong>');
    const row = await until(async () => {
      const current = await outboxRow(reference);
      return current.processed_at === null ? undefined : current;
    });
    expect(row.event_type).toBe('EMAIL_REQUESTED');
    expect(await pipeline.metrics.registry.getSingleMetricAsString('mtw_emails_sent_total')).toContain(
      'template="email-verification",provider="smtp"} 1',
    );
  });

  it('los parámetros viajan sellados: ni Postgres ni Valkey ven el código; el sello está atado a la referencia', async () => {
    const to = address('sellado');
    const code = String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, '0');
    const reference = await enqueue({
      to,
      template: 'login-unlock',
      params: {
        code,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        origin: { ipPrefix: '198.51.100.0/24', userAgent: null },
      },
    });
    const row = await outboxRow(reference);
    expect(JSON.stringify(row.payload)).not.toContain(code);
    const sealed = Buffer.from((row.payload as { sealed: string }).sealed, 'base64');
    const key = config.secrets.fieldEncryptionKey;
    expect(JSON.parse(decryptField(key, sealed, `email:${reference}`).toString('utf8'))).toMatchObject({ code });
    expect(() => decryptField(key, sealed, `email:${crypto.randomUUID()}`)).toThrow();

    const redis = testRedis(REDIS_DBS.emailDelivery);
    try {
      for (const key of await redis.keys('mtw:*')) {
        if ((await redis.type(key)) === 'hash') expect(JSON.stringify(await redis.hgetall(key))).not.toContain(code);
      }
    } finally {
      await redis.quit();
    }
    expect(codeFrom(await waitForMessage(to))).toBe(code);
  });

  it('un código ya vencido no se envía: se descarta, se mide y el evento queda procesado', async () => {
    const to = address('vencido');
    const reference = await enqueue({
      to,
      template: 'email-verification',
      params: { ...TEMPLATE_FIXTURES['email-verification'], expiresAt: new Date(Date.now() - 1_000).toISOString() },
    });
    await until(async () => ((await outboxRow(reference)).processed_at === null ? undefined : true));
    expect(await messagesTo(to)).toEqual([]);
    expect(await pipeline.metrics.registry.getSingleMetricAsString('mtw_emails_skipped_total')).toContain(
      'template="email-verification",reason="expired"} 1',
    );
  });

  it('un destinatario rechazado por el servidor (550) falla una sola vez, sin reintentos', async () => {
    const reference = await enqueue({
      to: `rechazado-${randomBytes(3).toString('hex')}@example.com`,
      template: 'new-login',
      params: TEMPLATE_FIXTURES['new-login'],
    });
    const job = await until(async () => {
      const failed = await pipeline.queues[QUEUES.email].getFailed();
      return failed.find((j) => j.data.aggregateId === reference);
    });
    expect(job.attemptsMade).toBe(1);
    expect(job.failedReason).toContain('550');
    expect((await outboxRow(reference)).processed_at).toBeNull();
    expect(await pipeline.metrics.registry.getSingleMetricAsString('mtw_email_send_errors_total')).toContain(
      'template="new-login",provider="smtp",retryable="false"} 1',
    );
  });
});

describe('reintentos ante una caída del SMTP', () => {
  let proxy: TcpProxy;
  let pipeline: EmailPipeline;

  beforeAll(async () => {
    const mailpit = inject('mailpit');
    proxy = await startTcpProxy({ host: mailpit.smtpHost, port: mailpit.smtpPort });
    pipeline = await startEmailPipeline({
      db: db.app,
      redisDb: REDIS_DBS.emailDelivery,
      fieldKey: config.secrets.fieldEncryptionKey,
      provider: new SmtpProvider({ host: proxy.host, port: proxy.port, from: 'no-reply@wallet.localhost' }),
    });
  });
  afterAll(async () => {
    await pipeline.stop();
    await proxy.close();
  });

  it('la cola de email reintenta 8 veces con espera exponencial desde 5 s', () => {
    expect(QUEUE_JOB_OPTIONS[QUEUES.email]).toMatchObject({
      attempts: 8,
      backoff: { type: 'exponential', delay: 5_000 },
    });
  });

  it('con el servidor caído el envío falla y se reintenta; al volver, se entrega una sola vez', async () => {
    proxy.setMode('refuse');
    const to = address('reintento');
    const reference = await enqueue({ to, template: 'totp-enabled', params: TEMPLATE_FIXTURES['totp-enabled'] });
    await until(async () =>
      (await pipeline.metrics.registry.getSingleMetricAsString('mtw_email_send_errors_total')).includes(
        'retryable="true"',
      )
        ? true
        : undefined,
    );
    expect(await messagesTo(to)).toEqual([]);
    proxy.setMode('pass');
    const message = await waitForMessage(to, () => true, 30_000);
    expect(message.subject).toBe('[MTW local] Activaste la verificación en dos pasos');
    await until(async () => ((await outboxRow(reference)).processed_at === null ? undefined : true));
    await sleep(500);
    expect(await messagesTo(to)).toHaveLength(1);
    expect(proxy.connections()).toBeGreaterThanOrEqual(2);
  });
});

describe('proveedores', () => {
  it('la configuración elige el adaptador', () => {
    const smtp = createEmailProvider({
      provider: 'smtp',
      from: 'a@b.test',
      networkLabel: 'x',
      smtpHost: '127.0.0.1',
      smtpPort: 1025,
    });
    expect(smtp).toBeInstanceOf(SmtpProvider);
    expect(smtp.name).toBe('smtp');
    const mailgun = createEmailProvider({
      provider: 'mailgun',
      from: 'no-reply@mg.example',
      networkLabel: 'x',
      apiKey: new Secret('clave-de-prueba'),
      domain: 'mg.example',
      baseUrl: 'https://api.mailgun.net',
    });
    expect(mailgun).toBeInstanceOf(MailgunProvider);
    expect(mailgun.name).toBe('mailgun');
  });
});
