// P18.MAN (M2): los emails de una operación de alto valor, armados por el mismo camino que en producción y sin fork ni
// base: los parámetros los arma el código del servicio (two-factor.ts y send/notifications.ts) con el monto en unidades
// mínimas como lo guarda la operación, el outbox real los sella, el handler real del worker los descifra y renderiza, y
// el texto que llega al proveedor dice el monto y el destino con el formato de la app ("1.000,00 USDC" y "0x " con los
// 10 grupos de 4), que es lo que la app pide comparar antes de escribir el código.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import type { Transaction } from 'kysely';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { Secret } from '../../src/config/secret.ts';
import type { OutboxEventInput, OutboxRepository } from '../../src/db/repositories/outbox-repository.ts';
import type { Database } from '../../src/db/schema.ts';
import { EmailOutbox, emailJobHandler, type EmailRequest } from '../../src/email/email-outbox.ts';
import type { EmailMessage, EmailProvider } from '../../src/email/provider.ts';
import type { TemplateName } from '../../src/email/templates.ts';
import { createLogger } from '../../src/observability/logger.ts';
import { createMetrics } from '../../src/observability/metrics.ts';
import { highValueChallengeEmail } from '../../src/operations/two-factor.ts';
import type { OutboxJobData } from '../../src/queue/queues.ts';
import { highValueExecutedNotice } from '../../src/send/notifications.ts';
import { DESTINATION, SAFE } from '../helpers/email-fixtures.ts';

/** La dirección como la muestran las apps Wallet y Recovery: `0x ` y los 10 grupos de 4 del EIP-55. */
const APP_GROUPED = '0x d8dA 6BF2 6964 aF9D 7eEd 9e03 E534 15D3 7aA9 6045';
const SAFE_GROUPED = '0x 8335 89fC D6eD b6E0 8f4c 7C32 D4f7 1b54 bdA0 2913';

/** Outbox y worker de email reales, con el repositorio y el proveedor en memoria. */
async function deliver<K extends TemplateName>(request: EmailRequest<K>): Promise<EmailMessage> {
  const key = new Secret(randomBytes(32));
  const events: OutboxEventInput[] = [];
  const repository = {
    enqueue: (_trx: Transaction<Database>, input: OutboxEventInput) => {
      events.push(input);
      return Promise.resolve(String(events.length));
    },
  } as unknown as OutboxRepository;
  await new EmailOutbox(repository, key).enqueue({} as Transaction<Database>, request);
  const [event] = events;
  if (!event) throw new Error('el outbox no recibió el email');
  // Sellado: ningún dato de la plantilla (ni el código) viaja en claro en el payload del outbox.
  expect(JSON.stringify(event.payload)).not.toContain(DESTINATION.slice(2, 10));
  const sent: EmailMessage[] = [];
  const provider: EmailProvider = {
    name: 'smtp',
    send: (message) => {
      sent.push(message);
      return Promise.resolve({ id: randomUUID() });
    },
    close: () => Promise.resolve(),
  };
  const handler = emailJobHandler({
    provider,
    fieldKey: key,
    appEnv: 'local',
    networkLabel: 'Base fork local — chainId 8453',
    logger: createLogger({ level: 'silent', service: 'test-operation-emails' }),
    metrics: createMetrics({ defaultMetrics: false }),
  });
  const data: OutboxJobData = {
    outboxEventId: '1',
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload: event.payload,
  };
  await handler(data, { attemptsMade: 0 } as unknown as Job<OutboxJobData>);
  const [message] = sent;
  if (!message) throw new Error('el worker no envió el email');
  return message;
}

const operation = {
  safe: getAddress(SAFE),
  tokenSymbol: 'USDC' as const,
  // 1.000 USDC en unidades mínimas, como lo guarda la intención canónica de la operación.
  amount: '1000000000',
  destination: getAddress(DESTINATION),
  nonce: '7',
};

describe('emails de alto valor por el camino real (servicio → outbox sellado → worker)', () => {
  it('el código de alto valor dice "1.000,00 USDC" y el destino con los grupos de la app', async () => {
    const message = await deliver(
      highValueChallengeEmail({
        to: 'ana@test.invalid',
        locale: 'es-AR',
        timeZone: 'America/Argentina/Buenos_Aires',
        operation,
        challenge: { secret: '27182818', expiresAt: new Date(Date.now() + 10 * 60_000) },
        origin: { ipPrefix: '203.0.113.0/24', userAgent: null },
      }),
    );
    expect(message.subject).toBe('[MTW local] Confirmá una operación de alto valor');
    expect(message.text).toContain('Acción: Envío de 1.000,00 USDC');
    expect(message.text).not.toMatch(/Envío de 1000 USDC/);
    expect(message.text).toContain(`Destino: ${APP_GROUPED}`);
    expect(message.text).toContain(`Safe: ${SAFE_GROUPED}`);
    expect(message.text).toContain('Código: 27182818');
    expect(message.html).toContain('Envío de 1.000,00 USDC');
    expect(message.html).toContain(APP_GROUPED);
  });

  it('montos con decimales y miles: sin redondear y con al menos 2 decimales', async () => {
    const message = await deliver(
      highValueChallengeEmail({
        to: 'ana@test.invalid',
        locale: 'es-AR',
        timeZone: 'UTC',
        operation: { ...operation, tokenSymbol: 'USDT', amount: '1234567890123' },
        challenge: { secret: '27182818', expiresAt: new Date(Date.now() + 10 * 60_000) },
        origin: { ipPrefix: null, userAgent: null },
      }),
    );
    expect(message.text).toContain('Acción: Envío de 1.234.567,890123 USDT');
  });

  it('el aviso de alto valor ejecutado: el email en es-AR y la notificación in-app con el monto que lee la app', async () => {
    const notice = highValueExecutedNotice({
      safe: getAddress(SAFE),
      token: 'USDC',
      amount: '1000000000',
      destination: DESTINATION,
      txHash: `0x${'9f'.repeat(32)}`,
      occurredAt: '2026-10-19T10:00:00.000Z',
    });
    // La app lee el monto del aviso en unidades del token (notifications.ts → "1.000,00 USDC").
    expect(notice.payload).toMatchObject({ amount: '1000', token: 'USDC', destination: getAddress(DESTINATION) });
    const message = await deliver({
      to: 'ana@test.invalid',
      template: 'high-value-executed',
      params: notice.email,
      locale: 'es-AR',
      timeZone: 'America/Argentina/Buenos_Aires',
      product: 'Wallet',
    });
    expect(message.text).toContain('Se enviaron 1.000,00 USDC.');
    expect(message.text).toContain('Acción: Envío de 1.000,00 USDC');
    expect(message.text).toContain(`Destino: ${APP_GROUPED}`);
  });
});
