// Lectura real de la casilla de prueba con la Gmail API (OAuth 2.0, scope gmail.readonly) para P09.TST.h: refresh
// token → access token, `users.messages.list` con una consulta por el Message-ID del envío (`rfc822msgid:`) incluyendo
// spam y papelera (el dominio sandbox compartido suele caer en spam) y `users.messages.get`. Ningún token se loguea ni
// viaja en un mensaje de error.
import { setTimeout as sleep } from 'node:timers/promises';
import type { GmailLiveEnv } from './live-env.ts';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailMessage {
  id: string;
  labelIds: string[];
  subject: string;
  messageId: string;
  headers: Record<string, string>;
  text: string;
  html: string;
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}

function collect(part: Part, out: { text: string; html: string }): void {
  const data = part.body?.data;
  if (data && part.mimeType === 'text/plain') out.text += Buffer.from(data, 'base64url').toString('utf8');
  if (data && part.mimeType === 'text/html') out.html += Buffer.from(data, 'base64url').toString('utf8');
  for (const child of part.parts ?? []) collect(child, out);
}

export class GmailReader {
  readonly #env: GmailLiveEnv;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(env: GmailLiveEnv) {
    this.#env = env;
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + 60_000) return this.#token.value;
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.#env.clientId,
        client_secret: this.#env.clientSecret.reveal(),
        refresh_token: this.#env.refreshToken.reveal(),
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Google OAuth respondió ${String(response.status)} al renovar el token de Gmail`);
    const json = (await response.json()) as { access_token?: string; expires_in?: number; scope?: string };
    if (!json.access_token) throw new Error('Google OAuth no devolvió un access token');
    if (!json.scope?.includes('gmail.readonly')) throw new Error('el token de Gmail no tiene el scope gmail.readonly');
    this.#token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  async #get<T>(path: string): Promise<T> {
    const response = await fetch(`${GMAIL}${path}`, {
      headers: { authorization: `Bearer ${await this.#accessToken()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Gmail API ${path.split('?')[0] ?? ''} respondió ${String(response.status)}`);
    return (await response.json()) as T;
  }

  /** Casilla de la cuenta autorizada (debe ser EMAIL_TEST_ADDRESS). */
  async profileAddress(): Promise<string> {
    return (await this.#get<{ emailAddress: string }>('/profile')).emailAddress.toLowerCase();
  }

  async list(query: string): Promise<string[]> {
    const params = new URLSearchParams({ q: query, includeSpamTrash: 'true', maxResults: '10' });
    const result = await this.#get<{ messages?: { id: string }[] }>(`/messages?${params.toString()}`);
    return (result.messages ?? []).map((m) => m.id);
  }

  async message(id: string): Promise<GmailMessage> {
    const raw = await this.#get<{ id: string; labelIds?: string[]; payload: Part }>(`/messages/${id}?format=full`);
    const headers = Object.fromEntries((raw.payload.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
    const body = { text: '', html: '' };
    collect(raw.payload, body);
    return {
      id: raw.id,
      labelIds: raw.labelIds ?? [],
      subject: headers.subject ?? '',
      messageId: headers['message-id'] ?? '',
      headers,
      text: body.text,
      html: body.html,
    };
  }

  /** Espera el email con ese Message-ID (bandeja de entrada, spam o papelera). */
  async waitForMessageId(messageId: string, timeoutMs = 240_000): Promise<GmailMessage> {
    const query = `rfc822msgid:${messageId.replace(/^<|>$/g, '')}`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [id] = await this.list(query);
      if (id) return this.message(id);
      if (Date.now() > deadline) throw new Error(`no llegó a Gmail el email ${messageId}`);
      await sleep(5_000);
    }
  }
}
