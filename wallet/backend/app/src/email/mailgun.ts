// Adaptador Mailgun [B-MAIL-01]: API HTTP con fetch nativo y autenticación Basic (`api:<API key>`), sin SDK.
// `POST /v3/<dominio>/messages`; la referencia del envío viaja como header y como variable para los eventos.
import type { Secret } from '../config/secret.ts';
import { EmailSendError, messageIdFor, type EmailMessage, type EmailProvider } from './provider.ts';

export interface MailgunOptions {
  baseUrl: string;
  domain: string;
  apiKey: Secret<string>;
  from: string;
  timeoutMs?: number;
}

export interface MailgunEvent {
  event: string;
  timestamp: number;
  recipient?: string | undefined;
  messageId?: string | undefined;
  /** Referencia del envío (variable `mtw-ref`). */
  reference?: string | undefined;
  /** Eventos `failed`: `permanent` o `temporary`, motivo y respuesta del servidor destino. */
  severity?: string | undefined;
  reason?: string | undefined;
  deliveryStatus?: { code?: number | undefined; message?: string | undefined } | undefined;
}

interface RawEvent {
  event: string;
  timestamp: number;
  recipient?: string;
  severity?: string;
  reason?: string;
  'delivery-status'?: { code?: number; message?: string; description?: string };
  message?: { headers?: Record<string, string> };
  'user-variables'?: Record<string, string>;
}

export class MailgunProvider implements EmailProvider {
  readonly name = 'mailgun' as const;
  readonly #options: MailgunOptions;

  constructor(options: MailgunOptions) {
    this.#options = options;
  }

  get domain(): string {
    return this.#options.domain;
  }

  #authorization(): string {
    return `Basic ${Buffer.from(`api:${this.#options.apiKey.reveal()}`).toString('base64')}`;
  }

  /**
   * Request a `/v3/<dominio>/<path>`. Red caída, timeout (también leyendo el cuerpo), 429 o 5xx → reintentable;
   * otro 4xx → definitivo. El cuerpo de error de Mailgun no se propaga (no incluye la API key, pero tampoco hace falta).
   */
  async #request<T>(path: string, init: { method: 'GET' | 'POST'; body?: URLSearchParams }, what: string): Promise<T> {
    try {
      const response = await fetch(`${this.#options.baseUrl}/v3/${this.#options.domain}/${path}`, {
        ...init,
        headers: { authorization: this.#authorization() },
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 20_000),
      });
      if (!response.ok) {
        throw new EmailSendError(`Mailgun rechazó ${what} (${String(response.status)})`, {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof EmailSendError) throw error;
      throw new EmailSendError(`Mailgun no respondió a ${what}`, { retryable: true, cause: error });
    }
  }

  async send(message: EmailMessage): Promise<{ id: string }> {
    const body = new URLSearchParams({
      from: this.#options.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      'h:Message-Id': messageIdFor(message.reference, this.#options.domain),
      'h:X-MTW-Ref': message.reference,
      'v:mtw-ref': message.reference,
    });
    for (const tag of message.tags) body.append('o:tag', tag);
    const json = await this.#request<{ id?: unknown }>('messages', { method: 'POST', body }, 'el envío');
    if (typeof json.id !== 'string') throw new EmailSendError('respuesta de Mailgun sin id', { retryable: false });
    return { id: json.id.replace(/^<|>$/g, '') };
  }

  /**
   * Eventos de la Events API (los tests reales confirman `delivered`). Filtros de Mailgun: message-id (sin `<>`),
   * tipo de evento, destinatario y desde cuándo.
   */
  async events(filter: {
    messageId?: string;
    event?: string;
    recipient?: string;
    begin?: Date;
    limit?: number;
  }): Promise<MailgunEvent[]> {
    const query = new URLSearchParams({ limit: String(filter.limit ?? 100) });
    if (filter.messageId !== undefined) query.set('message-id', filter.messageId.replace(/^<|>$/g, ''));
    if (filter.event !== undefined) query.set('event', filter.event);
    if (filter.recipient !== undefined) query.set('recipient', filter.recipient);
    if (filter.begin !== undefined) {
      query.set('begin', String(Math.floor(filter.begin.getTime() / 1000)));
      query.set('ascending', 'yes');
    }
    const json = await this.#request<{ items?: RawEvent[] }>(
      `events?${query.toString()}`,
      { method: 'GET' },
      'la consulta de eventos',
    );
    return (json.items ?? []).map((item) => ({
      event: item.event,
      timestamp: item.timestamp,
      recipient: item.recipient,
      messageId: item.message?.headers?.['message-id'],
      reference: item['user-variables']?.['mtw-ref'],
      severity: item.severity,
      reason: item.reason,
      deliveryStatus: item['delivery-status'] && {
        code: item['delivery-status'].code,
        message: item['delivery-status'].message ?? item['delivery-status'].description,
      },
    }));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
