// Envío de emails por el outbox [B-MAIL-01]: el pedido se guarda en la misma transacción que el cambio que lo origina
// (registro, reset, login…) y el worker lo envía con reintentos. Los parámetros de la plantilla (códigos, tokens,
// links de reset) se guardan cifrados con APP_FIELD_ENCRYPTION_KEY (AAD = id del pedido): ni Postgres ni Valkey ven
// un OTP en claro.
import { randomUUID } from 'node:crypto';
import { UnrecoverableError, type Job } from 'bullmq';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { AppEnv } from '../config/env.ts';
import type { Secret } from '../config/secret.ts';
import type { OutboxRepository } from '../db/repositories/outbox-repository.ts';
import type { Database } from '../db/schema.ts';
import { decryptField, encryptField } from '../lib/field-crypto.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { OutboxJobData } from '../queue/queues.ts';
import { EmailSendError, type EmailProvider } from './provider.ts';
import { renderTemplate, TEMPLATE_NAMES, type TemplateName, type TemplateParams } from './templates.ts';

export interface EmailRequest<K extends TemplateName> {
  to: string;
  template: K;
  params: TemplateParams[K];
  locale: string;
  timeZone: string;
  product: 'Wallet' | 'Recovery';
}

const PayloadSchema = z.object({
  to: z.string().min(3),
  template: z.enum(TEMPLATE_NAMES),
  locale: z.string(),
  timeZone: z.string(),
  product: z.enum(['Wallet', 'Recovery']),
  sealed: z.string(),
});

const aad = (reference: string) => `email:${reference}`;

export class EmailOutbox {
  readonly #outbox: OutboxRepository;
  readonly #key: Secret<Buffer>;

  constructor(outbox: OutboxRepository, fieldKey: Secret<Buffer>) {
    this.#outbox = outbox;
    this.#key = fieldKey;
  }

  /** Encola un email dentro de la transacción del llamador; devuelve la referencia del envío. */
  async enqueue<K extends TemplateName>(trx: Transaction<Database>, request: EmailRequest<K>): Promise<string> {
    const reference = randomUUID();
    const sealed = encryptField(this.#key, JSON.stringify(request.params), aad(reference)).toString('base64');
    await this.#outbox.enqueue(trx, {
      aggregateType: 'email',
      aggregateId: reference,
      eventType: 'EMAIL_REQUESTED',
      payload: {
        to: request.to,
        template: request.template,
        locale: request.locale,
        timeZone: request.timeZone,
        product: request.product,
        sealed,
      },
    });
    return reference;
  }
}

export interface EmailWorkerDeps {
  provider: EmailProvider;
  fieldKey: Secret<Buffer>;
  appEnv: AppEnv;
  networkLabel: string;
  logger: Logger;
  metrics: Metrics;
}

/** Handler del consumidor de la cola `email`: descifra, renderiza y envía; un error no reintentable no se reintenta. */
export function emailJobHandler(deps: EmailWorkerDeps) {
  const logger = deps.logger.child({ component: 'email-worker' });
  return async (data: OutboxJobData, job: Job<OutboxJobData>): Promise<void> => {
    const payload = PayloadSchema.parse(data.payload);
    const params = JSON.parse(
      decryptField(deps.fieldKey, Buffer.from(payload.sealed, 'base64'), aad(data.aggregateId)).toString('utf8'),
    ) as never;
    // Un código o link ya vencido no se envía (p. ej. re-encolado tras perder Valkey o después de una caída larga).
    const expiresAt = (params as { expiresAt?: unknown }).expiresAt;
    if (typeof expiresAt === 'string' && Date.parse(expiresAt) <= Date.now()) {
      deps.metrics.emailsSkipped.inc({ template: payload.template, reason: 'expired' });
      logger.warn({ reference: data.aggregateId, template: payload.template }, 'email no enviado: el código ya venció');
      return;
    }
    const rendered = renderTemplate(payload.template, params, {
      appEnv: deps.appEnv,
      locale: payload.locale,
      timeZone: payload.timeZone,
      product: payload.product,
      networkLabel: deps.networkLabel,
    });
    try {
      const sent = await deps.provider.send({
        to: payload.to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        reference: data.aggregateId,
        tags: ['mtw', payload.template],
      });
      deps.metrics.emailsSent.inc({ template: payload.template, provider: deps.provider.name });
      logger.info(
        { reference: data.aggregateId, template: payload.template, to: payload.to, providerId: sent.id },
        'email enviado',
      );
    } catch (error) {
      const retryable = !(error instanceof EmailSendError) || error.retryable;
      deps.metrics.emailSendErrors.inc({
        template: payload.template,
        provider: deps.provider.name,
        retryable: String(retryable),
      });
      const retryAfter = error instanceof EmailSendError ? error.retryAfter?.toISOString() : undefined;
      logger.warn(
        { reference: data.aggregateId, template: payload.template, err: error, attempt: job.attemptsMade, retryAfter },
        'email no enviado',
      );
      // UnrecoverableError: BullMQ no reintenta (p. ej. destinatario rechazado por el proveedor).
      if (!retryable) throw new UnrecoverableError(error instanceof Error ? error.message : 'envío rechazado');
      throw error;
    }
  };
}
