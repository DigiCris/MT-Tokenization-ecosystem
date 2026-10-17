// EmailProvider [B-MAIL-01]: `mailgun` (staging/producción y tests reales) y `smtp` (local/CI → Mailpit).
import type { EmailConfig } from '../config/env.ts';
import { MailgunProvider } from './mailgun.ts';
import { SmtpProvider } from './smtp.ts';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * Referencia única del envío (id del pedido en el outbox): viaja en el header X-MTW-Ref y define el Message-ID
   * (`<referencia@dominio del remitente>`), con lo que el envío se rastrea en los eventos del proveedor y en la casilla.
   */
  reference: string;
  tags: readonly string[];
}

export interface EmailProvider {
  readonly name: 'smtp' | 'mailgun';
  /** Id del mensaje en el proveedor. */
  send(message: EmailMessage): Promise<{ id: string }>;
  close(): Promise<void>;
}

/** Dominio de un remitente `addr@dominio` o `Nombre <addr@dominio>`. */
export function senderDomain(from: string): string {
  const match = /@([A-Za-z0-9.-]+)>?\s*$/.exec(from);
  if (!match?.[1]) throw new Error('remitente sin dominio');
  return match[1].toLowerCase();
}

/** Message-ID determinístico del envío: `<referencia@dominio>`. */
export function messageIdFor(reference: string, domain: string): string {
  return `<${reference}@${domain}>`;
}

export class EmailSendError extends Error {
  override name = 'EmailSendError';
  readonly status: number | undefined;
  readonly retryable: boolean;
  /** Desde cuándo el proveedor vuelve a aceptar envíos, si lo informó (429 por límite de ritmo o cuota diaria). */
  readonly retryAfter: Date | undefined;

  constructor(message: string, options: { status?: number; retryable: boolean; retryAfter?: Date; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfter = options.retryAfter;
  }
}

export function createEmailProvider(config: EmailConfig): EmailProvider {
  return config.provider === 'mailgun'
    ? new MailgunProvider({ baseUrl: config.baseUrl, domain: config.domain, apiKey: config.apiKey, from: config.from })
    : new SmtpProvider({ host: config.smtpHost, port: config.smtpPort, from: config.from });
}
