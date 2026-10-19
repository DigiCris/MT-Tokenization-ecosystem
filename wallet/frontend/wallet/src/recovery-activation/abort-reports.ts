// Avisos de aborto al backend (N10; revisión de seguridad de ADR-033, BAJO 6). Cada pedido de R abortado se informa con
// `POST /recovery/enrollments/{id}/reject` y una PlatformSession del propósito del pedido (ONBOARDING, u OPERATIONS en
// el reemplazo de R). Si en el momento no se puede (sin sesión o vencida —dura 15 min—, sin red, la plataforma no
// responde), el aviso queda en una cola en la memoria de la pestaña y se reenvía con la próxima sesión válida de ese
// propósito: el endpoint es idempotente y acepta un pedido ya reemplazado. La cola no va a Web Storage ([F-KEY-07]): si
// la pestaña se cierra antes, se pierde. Para dejar el pedido después de una comparación que no coincidió, la pantalla
// arma de antemano un aviso firmado que sale con `fetch` keepalive al cerrar o recargar la pestaña (`pagehide` no espera
// la firma, que es asíncrona).
import type { ApiClient } from '../api/client.ts';
import { ApiError } from '../api/problem.ts';
import type { PlatformAuth } from '../api/request-signature.ts';
import type { RejectReason } from './activation.ts';

export type EnrollmentPurpose = 'ONBOARDING' | 'REPLACEMENT';

export interface PendingAbort {
  enrollmentId: string;
  reason: RejectReason;
  /** null si no se sabe (un enlace abierto en una pestaña sin el pedido que no lo pudo leer): va con cualquier sesión. */
  purpose: EnrollmentPurpose | null;
}

/** La sesión con la que se informa: la PlatformSession, el propósito de los pedidos que rechaza y cuándo vence. */
export interface AbortSession {
  platform: PlatformAuth;
  purpose: EnrollmentPurpose;
  /** ISO 8601; sin él no se reintenta solo con esta sesión (espera la próxima). */
  expiresAt?: string;
}

export interface AbortReportsOptions {
  /** fetch para el aviso keepalive (en el navegador, el global). */
  fetch?: typeof fetch;
  /** Espera antes de reintentar con la misma sesión un aviso que no salió por la red o la plataforma. */
  retryMs?: number;
  now?: () => number;
  /** Cada cuánto se vuelve a firmar el aviso armado para `pagehide` (la firma vale ±60 s). */
  rearmMs?: number;
}

/** Qué hacer con un aviso después de intentarlo. */
type Outcome = 'done' | 'next' | 'retry' | 'stop';

export function rejectPath(enrollmentId: string): string {
  return `/recovery/enrollments/${encodeURIComponent(enrollmentId)}/reject`;
}

export class AbortReports {
  readonly #client: Pick<ApiClient, 'request' | 'prepare'>;
  readonly #fetch: typeof fetch;
  readonly #retryMs: number;
  readonly #rearmMs: number;
  readonly #now: () => number;
  readonly #pending = new Map<string, PendingAbort>();
  #flushing: Promise<void> = Promise.resolve();
  #retry: ReturnType<typeof setTimeout> | null = null;

  constructor(client: Pick<ApiClient, 'request' | 'prepare'>, options: AbortReportsOptions = {}) {
    this.#client = client;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#retryMs = options.retryMs ?? 15_000;
    this.#rearmMs = options.rearmMs ?? 30_000;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Los avisos que todavía no llegaron al backend (en orden de llegada). */
  pending(): readonly PendingAbort[] {
    return [...this.#pending.values()];
  }

  /** Informa un aborto: con la sesión, ya; si no se puede, queda en la cola para la próxima sesión válida. */
  report(abort: PendingAbort, session?: AbortSession): Promise<void> {
    // El primer motivo de un pedido es el que vale (el backend también conserva el primero).
    if (!this.#pending.has(abort.enrollmentId)) this.#pending.set(abort.enrollmentId, abort);
    return session === undefined ? Promise.resolve() : this.flush(session);
  }

  /** Reenvía los avisos pendientes que esa sesión puede informar (de a uno, sin solaparse con otra pasada). */
  flush(session: AbortSession): Promise<void> {
    this.#flushing = this.#flushing.then(() => this.#flush(session));
    return this.#flushing;
  }

  async #flush(session: AbortSession): Promise<void> {
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#retry = null;
    for (const abort of [...this.#pending.values()]) {
      if (abort.purpose !== null && abort.purpose !== session.purpose) continue;
      const outcome = await this.#send(abort, session.platform);
      if (outcome === 'done') this.#pending.delete(abort.enrollmentId);
      if (outcome === 'next') continue;
      if (outcome === 'stop') return;
      if (outcome === 'retry') {
        this.#scheduleRetry(session);
        return;
      }
    }
  }

  async #send(abort: PendingAbort, platform: PlatformAuth): Promise<Outcome> {
    try {
      await this.#client.request('POST', rejectPath(abort.enrollmentId), { platform, body: { reason: abort.reason } });
      return 'done';
    } catch (error) {
      if (!(error instanceof ApiError)) return 'retry';
      // Lo decidió el backend (el pedido no es de este usuario, ya terminó o no admite el rechazo): no se reintenta.
      if ([400, 404, 409, 422].includes(error.status)) return 'done';
      // Un pedido de otro propósito: queda para una sesión del que corresponde.
      if (error.code === 'SCOPE_NOT_ALLOWED') return 'next';
      // La sesión ya no sirve (vencida, cerrada): con la próxima.
      if (error.status === 401 || error.status === 403) return 'stop';
      // Rate limit o la plataforma no responde: más tarde, con la misma sesión si sigue vigente.
      return 'retry';
    }
  }

  #scheduleRetry(session: AbortSession): void {
    const expiresAt = session.expiresAt === undefined ? Number.NaN : Date.parse(session.expiresAt);
    // Con margen: un request firmado con una sesión a punto de vencer no llega a tiempo.
    if (!(expiresAt - this.#now() > this.#retryMs + 30_000)) return;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      void this.flush(session);
    }, this.#retryMs);
  }

  /**
   * Deja armado un aviso firmado para mandarlo con `fetch` keepalive si la pestaña se cierra o se recarga, y lo vuelve
   * a firmar antes de que venza la firma. `onSent` avisa que salió (si la pestaña vuelve del bfcache, el pedido ya está
   * abortado). Devuelve cómo desarmarlo.
   */
  armOnLeave(abort: PendingAbort, session: AbortSession, onSent: () => void): () => void {
    let prepared: { url: string; init: RequestInit } | null = null;
    let armed = true;
    const sign = () => {
      this.#client
        .prepare('POST', rejectPath(abort.enrollmentId), { platform: session.platform, body: { reason: abort.reason } })
        .then((request) => {
          if (armed) prepared = request;
        })
        .catch(() => {
          prepared = null;
        });
    };
    sign();
    const timer = setInterval(sign, this.#rearmMs);
    const onPageHide = () => {
      if (!armed) return;
      armed = false;
      clearInterval(timer);
      window.removeEventListener('pagehide', onPageHide);
      // Por si la pestaña no se cierra (vuelve del bfcache): el aviso queda también en la cola.
      if (!this.#pending.has(abort.enrollmentId)) this.#pending.set(abort.enrollmentId, abort);
      const request = prepared;
      prepared = null;
      if (request !== null) {
        this.#fetch(request.url, { ...request.init, keepalive: true }).then(
          (response) => {
            if (response.ok || [400, 404, 409, 422].includes(response.status)) this.#pending.delete(abort.enrollmentId);
          },
          () => undefined,
        );
      }
      onSent();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      armed = false;
      prepared = null;
      clearInterval(timer);
      window.removeEventListener('pagehide', onPageHide);
    };
  }
}
