// Adaptador SMTP [B-MAIL-01] para local y CI (Mailpit, SMTP real sin TLS en la red local). Nunca se usa en staging ni
// producción (la configuración lo rechaza, ADR-016).
import nodemailer, { type Transporter } from 'nodemailer';
import { EmailSendError, messageIdFor, senderDomain, type EmailMessage, type EmailProvider } from './provider.ts';

export interface SmtpOptions {
  host: string;
  port: number;
  from: string;
}

export class SmtpProvider implements EmailProvider {
  readonly name = 'smtp' as const;
  readonly #from: string;
  readonly #transport: Transporter;

  constructor(options: SmtpOptions) {
    this.#from = options.from;
    this.#transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }

  async send(message: EmailMessage): Promise<{ id: string }> {
    try {
      const info = await this.#transport.sendMail({
        messageId: messageIdFor(message.reference, senderDomain(this.#from)),
        from: this.#from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: { 'X-MTW-Ref': message.reference, 'X-MTW-Tags': message.tags.join(',') },
      });
      return { id: info.messageId.replace(/^<|>$/g, '') };
    } catch (error) {
      // Respuesta 5xx del servidor (p. ej. 550 destinatario inexistente): definitiva. 4xx o falla de conexión: reintento.
      const code = (error as { responseCode?: unknown }).responseCode;
      const permanent = typeof code === 'number' && code >= 500 && code < 600;
      throw new EmailSendError(
        permanent ? `el servidor SMTP rechazó el envío (${String(code)})` : 'el servidor SMTP no aceptó el envío',
        { retryable: !permanent, ...(typeof code === 'number' ? { status: code } : {}), cause: error },
      );
    }
  }

  close(): Promise<void> {
    this.#transport.close();
    return Promise.resolve();
  }
}
