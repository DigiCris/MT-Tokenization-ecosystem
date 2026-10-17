// P09.TST.g [B-MAIL-01]: adaptador `mailgun` contra la API real de Mailgun con el dominio sandbox. Cada una de las 19
// plantillas se envía a la casilla autorizada EMAIL_TEST_ADDRESS y el test confirma el evento `delivered` en la Events
// API (reenviando sólo ante el rechazo DMARC del sandbox compartido, ver helpers/mailgun-live.ts); además, los rechazos
// reales (API key inválida, destinatario no autorizado) se clasifican como no reintentables.
// Credenciales: variables de entorno o wallet/.env (nunca se imprimen).
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { Secret } from '../../src/config/secret.ts';
import { MailgunProvider } from '../../src/email/mailgun.ts';
import { EmailSendError } from '../../src/email/provider.ts';
import { renderTemplate, TEMPLATE_NAMES, type TemplateName } from '../../src/email/templates.ts';
import { TEMPLATE_FIXTURES } from '../helpers/email-fixtures.ts';
import { gmailLiveEnv, mailgunLiveEnv } from '../helpers/live-env.ts';
import {
  describeFailure,
  eventsOrRetry,
  isSandboxDmarcRejection,
  SANDBOX_MAX_SENDS,
  sendLikeWorker,
} from '../helpers/mailgun-live.ts';

const mailgun = mailgunLiveEnv();
const to = gmailLiveEnv().address;
const provider = new MailgunProvider(mailgun);

async function rejection(promise: Promise<unknown>): Promise<EmailSendError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EmailSendError) return error;
    throw error;
  }
  throw new Error('Mailgun aceptó un envío que debía rechazar');
}

describe('Mailgun real (sandbox)', () => {
  it('cada plantilla se acepta con su Message-ID y Mailgun confirma la entrega (delivered) a la casilla autorizada', async () => {
    const begin = new Date(Date.now() - 60_000);
    const runId = randomBytes(3).toString('hex');
    const context = {
      appEnv: 'local' as const,
      locale: 'es-AR',
      timeZone: 'America/Argentina/Buenos_Aires',
      product: 'Wallet' as const,
      networkLabel: 'Base fork local — chainId 8453',
    };
    /** Message-ID → plantilla, y envíos por plantilla (reenvíos ante el rechazo DMARC del sandbox). */
    const pending = new Map<string, TemplateName>();
    const sends = new Map<TemplateName, number>();
    let lastSentAt = Date.now();
    const send = async (name: TemplateName) => {
      const reference = randomUUID();
      const rendered = renderTemplate(name, TEMPLATE_FIXTURES[name] as never, context);
      const message = {
        to,
        subject: `${rendered.subject} · prueba ${runId}`,
        text: rendered.text,
        html: rendered.html,
        reference,
        tags: ['mtw', 'live-test', name],
      };
      const result = await sendLikeWorker(provider, message);
      lastSentAt = Date.now();
      // Mailgun respeta el Message-ID determinístico del envío.
      expect(result.id).toBe(`${reference}@${mailgun.domain}`);
      pending.set(result.id, name);
      sends.set(name, (sends.get(name) ?? 0) + 1);
    };
    for (const name of TEMPLATE_NAMES) await send(name);

    const delivered = new Map<TemplateName, string>();
    while (delivered.size < TEMPLATE_NAMES.length) {
      const round = [
        ...(await eventsOrRetry(provider, { event: 'delivered', recipient: to, begin })),
        ...(await eventsOrRetry(provider, { event: 'failed', recipient: to, begin })),
      ];
      for (const event of round) {
        const name = event.messageId === undefined ? undefined : pending.get(event.messageId);
        if (name === undefined || event.messageId === undefined) continue;
        if (event.event === 'delivered') {
          delivered.set(name, event.messageId);
          pending.delete(event.messageId);
        } else if (event.event === 'failed' && event.severity === 'permanent') {
          pending.delete(event.messageId);
          if (!isSandboxDmarcRejection(event)) throw new Error(`${name}: falla permanente ${describeFailure(event)}`);
          if ((sends.get(name) ?? 0) >= SANDBOX_MAX_SENDS)
            throw new Error(`${name}: rechazado por DMARC en todos los envíos`);
          await send(name);
        }
      }
      if (delivered.size === TEMPLATE_NAMES.length) break;
      // Plazo de entrega contado desde el último envío aceptado (los reintentos por 429 pueden demorar el envío).
      if (Date.now() > lastSentAt + 360_000) {
        const missing = TEMPLATE_NAMES.filter((n) => !delivered.has(n));
        throw new Error(`sin evento delivered para: ${missing.join(', ')}`);
      }
      await sleep(5_000);
    }
    expect([...delivered.keys()].sort()).toEqual([...TEMPLATE_NAMES].sort());

    // El evento lleva la referencia del envío (variable mtw-ref) para rastrearlo desde la base.
    const [firstId = ''] = [...delivered.values()];
    const events = await provider.events({ messageId: firstId, event: 'delivered' });
    expect(events[0]?.reference).toBe(firstId.split('@')[0]);
  }, 1_800_000);

  it('una API key inválida es un rechazo 401 no reintentable', async () => {
    const invalid = new MailgunProvider({ ...mailgun, apiKey: new Secret(`key-${randomBytes(16).toString('hex')}`) });
    const error = await rejection(
      invalid.send({
        to,
        subject: 'no se envía',
        text: 'x',
        html: '<p>x</p>',
        reference: randomUUID(),
        tags: ['mtw', 'live-test'],
      }),
    );
    expect(error.status).toBe(401);
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain(mailgun.apiKey.reveal());
  });

  it('un destinatario no autorizado del sandbox es un rechazo no reintentable', async () => {
    const error = await rejection(
      provider.send({
        to: `no-autorizado-${randomBytes(4).toString('hex')}@example.com`,
        subject: 'no se envía',
        text: 'x',
        html: '<p>x</p>',
        reference: randomUUID(),
        tags: ['mtw', 'live-test'],
      }),
    );
    expect(error.status).toBeGreaterThanOrEqual(400);
    expect(error.status).toBeLessThan(500);
    expect(error.retryable).toBe(false);
  });
});
