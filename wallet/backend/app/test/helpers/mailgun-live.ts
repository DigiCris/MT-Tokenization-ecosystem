// Seguimiento real de envíos de Mailgun para los tests live.
//
// El dominio sandbox de Mailgun firma DKIM y SPF como `sandbox.mgsend.net` mientras el From es
// `@sandbox….mailgun.org` (DMARC p=quarantine): Gmail manda esos emails a spam y rechaza una parte con 550 5.7.40 /
// 5.7.26 (From no alineado). Es una limitación del dominio sandbox compartido, no del adaptador: con el dominio propio
// de staging/producción (SPF y DKIM alineados) no ocurre. Los tests reenvían ante ese rechazo puntual —acotado— y
// fallan ante cualquier otro.
import { setTimeout as sleep } from 'node:timers/promises';
import { EmailSendError } from '../../src/email/provider.ts';
import type { MailgunEvent, MailgunProvider } from '../../src/email/mailgun.ts';

/**
 * Envíos máximos de un mismo email ante el rechazo DMARC del sandbox. Gmail rechaza ~30 % de esos envíos: con 8, la
 * probabilidad de que alguna de las 19 plantillas no llegue nunca es ≈ 0,1 % (0,3⁸ × 19).
 */
export const SANDBOX_MAX_SENDS = 8;

export function isSandboxDmarcRejection(event: MailgunEvent): boolean {
  return (
    event.event === 'failed' &&
    event.severity === 'permanent' &&
    /5\.7\.(40|26)/.test(event.deliveryStatus?.message ?? '')
  );
}

function describeFailure(event: MailgunEvent): string {
  return `${event.severity ?? '?'} ${event.reason ?? '?'} ${String(event.deliveryStatus?.code ?? '?')} ${(event.deliveryStatus?.message ?? '').slice(0, 200)}`;
}

/** Eventos de la Events API tolerando 429/5xx momentáneos (se reintenta en la próxima vuelta). */
export async function eventsOrRetry(
  provider: MailgunProvider,
  filter: Parameters<MailgunProvider['events']>[0],
): Promise<MailgunEvent[]> {
  try {
    return await provider.events(filter);
  } catch (error) {
    if (error instanceof EmailSendError && error.retryable) return [];
    throw error;
  }
}

export type DeliveryOutcome = 'delivered' | 'rejected-dmarc';

/**
 * Espera el resultado de un envío (por Message-ID): `delivered`, o `rejected-dmarc` si Gmail lo rechazó por la
 * alineación del sandbox. Cualquier otra falla permanente es un error del test.
 */
export async function waitForOutcome(
  provider: MailgunProvider,
  messageId: string,
  timeoutMs = 240_000,
): Promise<DeliveryOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await eventsOrRetry(provider, { messageId });
    if (events.some((e) => e.event === 'delivered')) return 'delivered';
    const failed = events.find((e) => e.event === 'failed' && e.severity === 'permanent');
    if (failed) {
      if (isSandboxDmarcRejection(failed)) return 'rejected-dmarc';
      throw new Error(`Mailgun informó una falla permanente: ${describeFailure(failed)}`);
    }
    if (Date.now() > deadline) throw new Error(`sin resultado de entrega para ${messageId}`);
    await sleep(5_000);
  }
}

export { describeFailure };
