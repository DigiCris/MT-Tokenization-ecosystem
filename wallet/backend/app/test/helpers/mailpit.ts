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

/** Mensajes para un destinatario, del más viejo al más nuevo. */
export async function messagesTo(address: string): Promise<MailpitMessage[]> {
  const result = await api<{ messages: Summary[] }>(
    `/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=50`,
  );
  const ids = result.messages.sort((a, b) => a.Created.localeCompare(b.Created)).map((m) => m.ID);
  return Promise.all(ids.map((id) => full(id)));
}

/** Espera hasta que llegue un mensaje para el destinatario que cumpla el predicado. */
export async function waitForMessage(
  address: string,
  predicate: (message: MailpitMessage) => boolean = () => true,
  timeoutMs = 30_000,
): Promise<MailpitMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = (await messagesTo(address)).reverse().find(predicate);
    if (match) return match;
    if (Date.now() > deadline) throw new Error(`no llegó el email esperado a ${address}`);
    await sleep(150);
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
