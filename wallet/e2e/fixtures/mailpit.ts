// Emails reales que el worker del stack entregó por SMTP a Mailpit (P22.T01): códigos de 8 dígitos y enlaces de reset.
import { stack } from './stack.ts';

interface Summary {
  ID: string;
  Created: string;
}

export interface Mail {
  id: string;
  subject: string;
  text: string;
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${stack().urls.mailpit}${path}`);
  if (!response.ok) throw new Error(`Mailpit ${path}: ${String(response.status)}`);
  return (await response.json()) as T;
}

const seen = new Set<string>();

/** El próximo email nuevo para la casilla que cumpla el predicado (cada email se consume una vez). */
export async function nextMail(
  address: string,
  predicate: (mail: Mail) => boolean = () => true,
  timeoutMs = 90_000,
): Promise<Mail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { messages } = await api<{ messages: Summary[] }>(
      `/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=50`,
    );
    for (const summary of messages.sort((a, b) => a.Created.localeCompare(b.Created))) {
      if (seen.has(summary.ID)) continue;
      const full = await api<{ ID: string; Subject: string; Text: string }>(`/api/v1/message/${summary.ID}`);
      const mail = { id: full.ID, subject: full.Subject, text: full.Text };
      if (predicate(mail)) {
        seen.add(summary.ID);
        return mail;
      }
    }
    if (Date.now() > deadline) throw new Error(`no llegó el email esperado para ${address}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
}

export function codeFrom(mail: Mail): string {
  const match = /Código: (\d{8})/.exec(mail.text);
  if (!match?.[1]) throw new Error(`el email "${mail.subject}" no tiene un código de 8 dígitos`);
  return match[1];
}

export function resetLinkFrom(mail: Mail): string {
  const match = /(https?:\/\/\S+\/reset-password#token=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43})/.exec(mail.text);
  if (!match?.[1]) throw new Error('el email no tiene un enlace de reset');
  return match[1];
}

export async function nextCode(address: string, timeoutMs?: number): Promise<string> {
  return codeFrom(await nextMail(address, (mail) => /Código: \d{8}/.test(mail.text), timeoutMs));
}
