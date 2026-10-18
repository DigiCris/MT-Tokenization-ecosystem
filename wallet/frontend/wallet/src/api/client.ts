// Cliente HTTP de la API de Wallet ([F-SES-01], [F-SES-03]): cookies de cuenta con `credentials: 'include'` contra el
// API host de esta app, token CSRF sólo en memoria (anónimo antes del login, atado a la sesión después; se actualiza
// cuando una respuesta trae `csrfToken` porque la sesión rotó), `Idempotency-Key` en las rutas idempotentes, firma de
// los requests críticos con la session key de la PlatformSession y errores RFC 9457. Un 403 CSRF_TOKEN_INVALID se
// reintenta una sola vez con un token nuevo: el backend lo rechaza antes de ejecutar nada.
import { toBase64Url } from '../crypto/bytes.ts';
import { ApiError, NetworkError, problemOf, retryAfterSeconds } from './problem.ts';
import { criticalHeaders, systemClock, type PlatformAuth, type SignatureClock } from './request-signature.ts';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface ApiClientOptions {
  /** Base con el prefijo de versión, p. ej. `https://api-wallet.example/api/v1`. */
  baseUrl: string;
  /** En el navegador, el fetch global; en Node (tests contra el stack) uno con cookies y Origin. */
  fetch?: typeof fetch;
  clock?: SignatureClock;
  timeoutMs?: number;
}

export interface RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
  /** Firma el request con la PlatformSession ([B-PSES-05]). */
  platform?: PlatformAuth;
  signal?: AbortSignal;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

/** 16 bytes aleatorios en base64url (22 caracteres): se reutiliza en los reintentos de la misma acción. */
export function newIdempotencyKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

function hasCsrfToken(value: unknown): value is { csrfToken: string } {
  return (
    typeof value === 'object' && value !== null && typeof (value as { csrfToken?: unknown }).csrfToken === 'string'
  );
}

export class ApiClient {
  readonly baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #clock: SignatureClock;
  readonly #timeoutMs: number;
  #csrf: string | null = null;
  #csrfPending: Promise<string> | null = null;

  constructor(options: ApiClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.search !== '' || url.hash !== '') throw new TypeError('baseUrl sin query ni fragmento');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Hora para los timestamps firmados (alineada con el servidor si el reloj lo está). */
  now(): number {
    return this.#clock.now();
  }

  /** Hora del servidor recibida en una respuesta (p. ej. `issuedAt` de una PlatformSession). */
  observeServerTime(serverTimeIso: string): void {
    this.#clock.observe?.(serverTimeIso);
  }

  /** La sesión rotó o se cerró: el próximo request no-GET pide un token nuevo. */
  clearCsrfToken(): void {
    this.#csrf = null;
  }

  setCsrfToken(token: string): void {
    this.#csrf = token;
  }

  async csrfToken(): Promise<string> {
    if (this.#csrf !== null) return this.#csrf;
    this.#csrfPending ??= this.#send<{ csrfToken: string }>('GET', '/auth/csrf', {})
      .then((response) => {
        if (!hasCsrfToken(response)) throw new Error('GET /auth/csrf sin csrfToken');
        this.#csrf = response.csrfToken;
        return response.csrfToken;
      })
      .finally(() => {
        this.#csrfPending = null;
      });
    return this.#csrfPending;
  }

  async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    if (options.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(options.idempotencyKey)) {
      throw new TypeError('Idempotency-Key inválido');
    }
    try {
      return await this.#send<T>(method, path, options);
    } catch (error) {
      if (method === 'GET' || !(error instanceof ApiError) || error.code !== 'CSRF_TOKEN_INVALID') throw error;
      this.#csrf = null;
      return this.#send<T>(method, path, options);
    }
  }

  async #send<T>(method: HttpMethod, path: string, options: RequestOptions): Promise<T> {
    if (!path.startsWith('/')) throw new TypeError('el path empieza con /');
    const url = `${this.baseUrl}${path}`;
    const body =
      method === 'POST' || method === 'PATCH'
        ? JSON.stringify(options.body ?? {})
        : options.body === undefined
          ? ''
          : JSON.stringify(options.body);
    const headers: Record<string, string> = { Accept: 'application/json, application/problem+json' };
    if (body !== '') headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-CSRF-Token'] = await this.csrfToken();
    if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;
    if (options.platform) {
      const { pathname, search } = new URL(url);
      Object.assign(
        headers,
        await criticalHeaders(options.platform, method, `${pathname}${search}`, body, this.#clock),
      );
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        ...(body === '' ? {} : { body }),
        credentials: 'include',
        mode: 'cors',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new NetworkError(timeout.aborted ? 'la API no respondió a tiempo' : 'no se pudo contactar a la API');
    }
    const text = await response.text();
    let json: unknown = undefined;
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!response.ok) {
      const problem = problemOf(response.status, json, response.headers.get('X-Request-Id'));
      if (problem.code === 'UNAUTHENTICATED') this.#csrf = null;
      throw new ApiError(problem, retryAfterSeconds(response.headers.get('Retry-After')));
    }
    if (text !== '' && json === undefined) throw new NetworkError('respuesta de la API que no es JSON');
    if (hasCsrfToken(json)) this.#csrf = json.csrfToken;
    return json as T;
  }
}
