// Lectura real de la casilla de prueba (EMAIL_TEST_ADDRESS) con la Gmail API para el E2E de entrega real (P22.T06):
// refresh token de EMAIL_TEST_* → access token con scope gmail.readonly (sólo renovar: nunca se revoca nada y ninguna
// página recibe este token), búsqueda de los emails que llegaron después de que empezó el test (bandeja de entrada,
// spam o papelera: el dominio sandbox compartido suele caer en spam) y lectura del cuerpo. Ningún token se imprime ni
// viaja en un mensaje de error.
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readEnvFile } from '../../frontend/wallet/build/env-file.ts';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
type Setting =
  | 'EMAIL_TEST_ADDRESS'
  | 'EMAIL_TEST_GOOGLE_CLIENT_ID'
  | 'EMAIL_TEST_GOOGLE_CLIENT_SECRET'
  | 'EMAIL_TEST_GOOGLE_REFRESH_TOKEN';

export interface GmailMessage {
  id: string;
  subject: string;
  /** Momento en que Gmail lo recibió (ms). */
  receivedAt: number;
  text: string;
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}

function textOf(part: Part): string {
  const own =
    part.mimeType === 'text/plain' && part.body?.data ? Buffer.from(part.body.data, 'base64url').toString() : '';
  return own + (part.parts ?? []).map(textOf).join('');
}

function setting(name: Setting): string {
  const dotenv = readEnvFile(resolve(import.meta.dirname, '../../.env')) ?? {};
  const value = process.env[name] || dotenv[name] || '';
  if (value === '') throw new Error(`falta ${name} (E2E de entrega real, P22.T06)`);
  return value;
}

/** La casilla autorizada en el sandbox de Mailgun (la cuenta del test se registra con ese email exacto). */
export function testAddress(): string {
  return setting('EMAIL_TEST_ADDRESS').toLowerCase();
}

let token: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: setting('EMAIL_TEST_GOOGLE_CLIENT_ID'),
      client_secret: setting('EMAIL_TEST_GOOGLE_CLIENT_SECRET'),
      refresh_token: setting('EMAIL_TEST_GOOGLE_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Google OAuth respondió ${String(response.status)} al renovar el token de Gmail`);
  const json = (await response.json()) as { access_token?: string; expires_in?: number; scope?: string };
  if (!json.access_token) throw new Error('Google OAuth no devolvió un access token');
  if (!json.scope?.includes('gmail.readonly')) throw new Error('el token de Gmail no tiene el scope gmail.readonly');
  token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${GMAIL}${path}`, {
    headers: { authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Gmail API ${path.split('?')[0] ?? ''} respondió ${String(response.status)}`);
  return (await response.json()) as T;
}

async function message(id: string): Promise<GmailMessage> {
  const raw = await get<{ id: string; internalDate: string; payload: Part }>(`/messages/${id}?format=full`);
  const headers = Object.fromEntries((raw.payload.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
  return {
    id: raw.id,
    subject: headers.subject ?? '',
    receivedAt: Number(raw.internalDate),
    text: textOf(raw.payload),
  };
}

/**
 * Espera el email más reciente a la casilla de prueba con ese asunto que llegó después de `since` y que no se consumió
 * antes (si se pidió otro envío, el anterior ya no sirve).
 * `onWait` corre cada `retryEveryMs` sin el email (p. ej. pedir otro envío ante un rechazo del sandbox de Mailgun).
 */
export async function nextGmail(
  subject: string,
  since: number,
  options: { timeoutMs?: number; retryEveryMs?: number; onWait?: () => Promise<void>; seen?: Set<string> } = {},
): Promise<GmailMessage> {
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  const seen = options.seen ?? new Set<string>();
  let nextRetry = Date.now() + (options.retryEveryMs ?? 180_000);
  const query = `to:${testAddress()} subject:"${subject}" newer_than:1d`;
  for (;;) {
    const params = new URLSearchParams({ q: query, includeSpamTrash: 'true', maxResults: '20' });
    const listed = await get<{ messages?: { id: string }[] }>(`/messages?${params.toString()}`);
    const fresh: GmailMessage[] = [];
    for (const { id } of listed.messages ?? []) {
      if (seen.has(id)) continue;
      const found = await message(id);
      // Gmail guarda el momento con resolución de segundos: un margen de 2 s para no perder el primero.
      if (found.receivedAt >= since - 2_000 && found.subject.includes(subject)) fresh.push(found);
    }
    const latest = fresh.sort((a, b) => b.receivedAt - a.receivedAt)[0];
    if (latest) {
      for (const mail of fresh) seen.add(mail.id);
      return latest;
    }
    if (Date.now() > deadline) throw new Error(`no llegó a Gmail el email «${subject}»`);
    if (options.onWait && Date.now() > nextRetry) {
      await options.onWait();
      nextRetry = Date.now() + (options.retryEveryMs ?? 180_000);
    }
    await sleep(5_000);
  }
}

export function codeIn(mail: GmailMessage): string {
  const match = /Código: (\d{8})/.exec(mail.text);
  if (!match?.[1]) throw new Error(`el email «${mail.subject}» no tiene un código de 8 dígitos`);
  return match[1];
}

export function resetLinkIn(mail: GmailMessage): string {
  const match = /(https?:\/\/\S+\/reset-password#token=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43})/.exec(mail.text);
  if (!match?.[1]) throw new Error('el email no tiene un enlace de reset');
  return match[1];
}
