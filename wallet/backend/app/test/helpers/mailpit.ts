// Lectura de los emails reales que llegaron a Mailpit (API HTTP de Mailpit).
import { setTimeout as sleep } from 'node:timers/promises';
import { inject } from 'vitest';

export interface MailpitMessage {
  id: string;
  subject: string;
  to: string[];
  text: string;
  html: string;
  headers: Record<string, string[]>;
}

interface Summary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  Created: string;
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${inject('mailpit').apiUrl}${path}`);
  if (!response.ok) throw new Error(`Mailpit ${path}: ${String(response.status)}`);
  return (await response.json()) as T;
}

async function full(id: string): Promise<MailpitMessage> {
  const message = await api<{ ID: string; Subject: string; To: { Address: string }[]; Text: string; HTML: string }>(
    `/api/v1/message/${id}`,
  );
  const headers = await api<Record<string, string[]>>(`/api/v1/message/${id}/headers`);
  return {
    id: message.ID,
    subject: message.Subject,
    to: message.To.map((t) => t.Address),
    text: message.Text,
    html: message.HTML,
    headers,
  };
}

// Cada mensaje se pide completo (cuerpo y headers) una sola vez: con varios archivos de test sondeando en paralelo,
// pedir todo en cada vuelta saturaba a Mailpit, el SMTP del worker vencía y el reintento llegaba tarde.
const fullCache = new Map<string, Promise<MailpitMessage>>();

function cachedFull(id: string): Promise<MailpitMessage> {
  let message = fullCache.get(id);
  if (!message) {
    message = full(id);
    // Un fallo transitorio de la API no queda cacheado.
    message.catch(() => fullCache.delete(id));
    fullCache.set(id, message);
  }
  return message;
}

async function summariesTo(address: string): Promise<Summary[]> {
  const result = await api<{ messages: Summary[] }>(
    `/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=50`,
  );
  return result.messages.sort((a, b) => a.Created.localeCompare(b.Created));
}

/** Mensajes para un destinatario, del más viejo al más nuevo. */
export async function messagesTo(address: string): Promise<MailpitMessage[]> {
  return Promise.all((await summariesTo(address)).map((m) => cachedFull(m.ID)));
}

/**
 * Espera hasta que llegue un mensaje para el destinatario que cumpla el predicado. El plazo cubre un reintento del
 * worker de email (backoff de 5 s tras un intento que puede tardar hasta el socketTimeout de 15 s del SMTP).
 */
export async function waitForMessage(
  address: string,
  predicate: (message: MailpitMessage) => boolean = () => true,
  timeoutMs = 60_000,
): Promise<MailpitMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const summaries = (await summariesTo(address)).reverse();
    for (const summary of summaries) {
      const message = await cachedFull(summary.ID);
      if (predicate(message)) return message;
    }
    if (Date.now() > deadline) throw new Error(`no llegó el email esperado a ${address}`);
    await sleep(250);
  }
}

/** Código de 8 dígitos del cuerpo de texto. */
export function codeFrom(message: MailpitMessage): string {
  const match = /Código: (\d{8})/.exec(message.text);
  if (!match?.[1]) throw new Error('el email no tiene un código de 8 dígitos');
  return match[1];
}

/** Token del enlace de reset (fragmento `#token=`). */
export function resetTokenFrom(message: MailpitMessage): string {
  const match = /#token=([0-9a-f-]{36}\.[A-Za-z0-9_-]{43})/.exec(message.text);
  if (!match?.[1]) throw new Error('el email no tiene un enlace de reset');
  return match[1];
}
