// Alertas del chequeo off-host (P20.T02.a): por webhook (`ALERT_WEBHOOK_URL`, JSON) y por email con la API HTTP de
// Mailgun (`EMAIL_PROVIDER_API_KEY`, `EMAIL_PROVIDER_DOMAIN`, `EMAIL_PROVIDER_BASE_URL`, destino `ALERT_EMAIL_TO`). El
// texto lleva la app, el estado y los problemas encontrados (rutas y motivos), nunca credenciales.
import type { CheckResult } from './check.ts';

export interface AlertChannels {
  webhookUrl?: string;
  mailgun?: { apiKey: string; domain: string; baseUrl: string; to: string };
}

export function alertChannels(env: Record<string, string | undefined> = process.env): AlertChannels {
  const channels: AlertChannels = {};
  if (env.ALERT_WEBHOOK_URL) channels.webhookUrl = env.ALERT_WEBHOOK_URL;
  const { EMAIL_PROVIDER_API_KEY: apiKey, EMAIL_PROVIDER_DOMAIN: domain, ALERT_EMAIL_TO: to } = env;
  if (apiKey && domain && to) {
    channels.mailgun = { apiKey, domain, to, baseUrl: env.EMAIL_PROVIDER_BASE_URL || 'https://api.mailgun.net' };
  }
  return channels;
}

export function alertText(results: readonly CheckResult[], source: string): { subject: string; text: string } {
  const failing = results.filter((r) => r.status !== 'OK');
  const subject = `[MT Wallet] Integridad: ${failing.map((r) => `${r.app} ${r.status}`).join(', ')} (${source})`;
  const text = failing
    .map((r) =>
      [
        `${r.app}: ${r.status} (release ${r.releaseId ?? 'desconocido'}, ${String(r.files)} archivos revisados)`,
        ...r.problems.slice(0, 30).map((p) => `  - ${p}`),
      ].join('\n'),
    )
    .join('\n\n');
  return { subject, text: `${text}\n\nRunbook: wallet/docs/runbooks/integrity-mismatch.md\n` };
}

/** Envía la alerta por cada canal configurado; devuelve los canales que la aceptaron. */
export async function sendAlert(
  channels: AlertChannels,
  message: { subject: string; text: string },
  doFetch: typeof fetch = fetch,
): Promise<string[]> {
  const sent: string[] = [];
  if (channels.webhookUrl) {
    const response = await doFetch(channels.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) sent.push('webhook');
  }
  if (channels.mailgun) {
    const { apiKey, domain, baseUrl, to } = channels.mailgun;
    const response = await doFetch(`${baseUrl.replace(/\/+$/, '')}/v3/${encodeURIComponent(domain)}/messages`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}` },
      body: new URLSearchParams({ from: `MT Wallet integridad <integrity@${domain}>`, to, ...message }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) sent.push('email');
  }
  return sent;
}
