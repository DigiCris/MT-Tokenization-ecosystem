// Seguimiento real de envíos de Mailgun para los tests live.
//
// El dominio sandbox de Mailgun firma DKIM y SPF como `sandbox.mgsend.net` mientras el From es
// `@sandbox….mailgun.org` (DMARC p=quarantine): Gmail manda esos emails a spam y rechaza una parte con 550 5.7.40 /
// 5.7.26 (From no alineado). Es una limitación del dominio sandbox compartido, no del adaptador: con el dominio propio
// de staging/producción (SPF y DKIM alineados) no ocurre. Los tests reenvían ante ese rechazo puntual —acotado— y
// fallan ante cualquier otro.
//
// Mailgun también limita el ritmo de la cuenta free (429 durante algunos minutos tras una ráfaga). El worker lo absorbe
// con los reintentos de la cola de email (QUEUE_JOB_OPTIONS); los tests esperan con esa misma política y no con una
// propia más corta.
import { setTimeout as sleep } from 'node:timers/promises';
import { EmailSendError, type EmailMessage } from '../../src/email/provider.ts';
import type { MailgunEvent, MailgunProvider } from '../../src/email/mailgun.ts';
import { QUEUE_JOB_OPTIONS, QUEUES } from '../../src/queue/queues.ts';

const EMAIL_JOB = QUEUE_JOB_OPTIONS[QUEUES.email];
const EMAIL_ATTEMPTS = EMAIL_JOB.attempts ?? 1;
const EMAIL_BACKOFF = EMAIL_JOB.backoff;
if (typeof EMAIL_BACKOFF !== 'object' || EMAIL_BACKOFF.type !== 'exponential' || EMAIL_BACKOFF.delay === undefined) {
  throw new Error('la cola de email dejó de usar backoff exponencial: actualizar helpers/mailgun-live.ts');
}
const EMAIL_BACKOFF_DELAY_MS = EMAIL_BACKOFF.delay;

/** Espera de BullMQ antes del intento `attempt + 1` (backoff exponencial: delay · 2^(intentos hechos − 1)). */
export function emailBackoffMs(attemptsMade: number): number {
  return EMAIL_BACKOFF_DELAY_MS * 2 ** (attemptsMade - 1);
}

/** Tiempo total que el worker sigue reintentando un email antes de darlo por fallido (≈ 10,5 min). */
export const EMAIL_RETRY_WINDOW_MS = Array.from({ length: EMAIL_ATTEMPTS - 1 }, (_, i) => emailBackoffMs(i + 1)).reduce(
  (a, b) => a + b,
  0,
);

/**
 * El dominio sandbox tiene una cuota de 100 pedidos por día (429 "daily request limit (100) exceeded, try again after
 * <fecha>"): si Mailgun no vuelve a aceptar envíos antes de que se agote la ventana de reintentos, el test falla en el
 * acto con la fecha en lugar de esperar 10 minutos.
 */
export class MailgunQuotaExhaustedError extends Error {
  override name = 'MailgunQuotaExhaustedError';
  readonly until: Date;

  constructor(until: Date) {
    super(`Mailgun no acepta envíos del dominio hasta ${until.toISOString()} (cuota diaria del sandbox agotada)`);
    this.until = until;
  }
}

export function assertQuotaWindow(retryAfter: Date | undefined, remainingMs: number): void {
  if (retryAfter !== undefined && retryAfter.getTime() > Date.now() + remainingMs) {
    throw new MailgunQuotaExhaustedError(retryAfter);
  }
}

/** Envía como el worker: un error reintentable (red, 429, 5xx) se reintenta con la política de la cola de email. */
export async function sendLikeWorker(provider: MailgunProvider, message: EmailMessage): Promise<{ id: string }> {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await provider.send(message);
    } catch (error) {
      if (!(error instanceof EmailSendError) || !error.retryable || attempt >= EMAIL_ATTEMPTS) throw error;
      assertQuotaWindow(error.retryAfter, EMAIL_RETRY_WINDOW_MS - (Date.now() - started));
      await sleep(emailBackoffMs(attempt));
    }
  }
}

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

export { describeFailure };
