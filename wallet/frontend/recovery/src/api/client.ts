// Cliente del API de Recovery ([F-SES-01/03], listener de Recovery): cookie de cuenta propia (`credentials: 'include'`),
// token CSRF en memoria (GET /auth/csrf; lo renuevan login y step-up, y se pide de nuevo una vez si el backend lo
// rechaza), Idempotency-Key en los POST que crean recursos, problemas RFC 9457 como ApiError y requests críticos
// firmados con la session key de la PlatformSession ([B-PSES-05]): X-Platform-Session + X-Session-Timestamp (segundos
// Unix con la hora alineada al servidor) + X-Session-Nonce (16 bytes hex) + X-Session-Signature (P-256 P1363 base64url
// sobre `MTW-REQ-V1\n{método}\n{path con query}\n{sha256hex(body)}\n{timestamp}\n{nonce}\n{sessionId}`).
import { bytesToHex } from '../crypto/encoding.ts';
import { sha256Hex, signP256 } from './session-key.ts';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** PlatformSession: token del header y session key (la privada no extraíble). */
export interface PlatformAuth {
  token: string;
  sessionId: string;
  key: CryptoKey;
}

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: string;
  readonly detail: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, code: string, title: string, detail: string | null, retryAfterSeconds: number | null) {
    super(detail ?? title);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Hora para los timestamps firmados, alineada con la del servidor (`issuedAt` de cada PlatformSession). */
export class ServerClock {
  #offsetMs = 0;

  nowMs(): number {
    return Date.now() + this.#offsetMs;
  }

  nowSeconds(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  observe(serverTimeIso: string): void {
    const server = Date.parse(serverTimeIso);
    if (!Number.isNaN(server)) this.#offsetMs = server - Date.now();
  }
}

export interface RequestOptions {
  body?: unknown;
  platform?: PlatformAuth;
  idempotencyKey?: string;
}

export function newIdempotencyKey(): string {
  return `rcv-${crypto.randomUUID()}`;
}

function requestNonce(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16))).slice(2);
}

export function canonicalRequest(input: {
  method: HttpMethod;
  path: string;
  bodySha256Hex: string;
  timestamp: string;
  nonce: string;
  sessionId: string;
}): string {
  return [
    'MTW-REQ-V1',
    input.method,
    input.path,
    input.bodySha256Hex,
    input.timestamp,
    input.nonce,
    input.sessionId,
  ].join('\n');
}

interface Problem {
  code?: unknown;
  title?: unknown;
  detail?: unknown;
}

export class ApiClient {
  readonly #base: URL;
  readonly #fetch: typeof fetch;
  readonly clock: ServerClock;
  #csrf: string | null = null;
  #csrfPending: Promise<string> | null = null;

  constructor(baseUrl: string, options: { fetch?: typeof fetch; clock?: ServerClock } = {}) {
    this.#base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.clock = options.clock ?? new ServerClock();
  }

  /** Token CSRF de la sesión nueva (login y step-up rotan la sesión de cuenta y lo devuelven). */
  setCsrfToken(token: string): void {
    this.#csrf = token;
  }

  clearCsrfToken(): void {
    this.#csrf = null;
  }

  async #csrfToken(): Promise<string> {
    if (this.#csrf !== null) return this.#csrf;
    this.#csrfPending ??= this.#send<{ csrfToken?: unknown }>('GET', 'auth/csrf', {}, null)
      .then((response) => {
        if (typeof response.csrfToken !== 'string') throw new Error('GET /auth/csrf sin csrfToken');
        this.#csrf = response.csrfToken;
        return response.csrfToken;
      })
      .finally(() => {
        this.#csrfPending = null;
      });
    return this.#csrfPending;
  }

  async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    const unsafe = method !== 'GET';
    try {
      return await this.#send<T>(method, path, options, unsafe ? await this.#csrfToken() : null);
    } catch (error) {
      // Una sesión rotada en otra pestaña o un token anónimo vencido: se pide uno nuevo y se reintenta una vez.
      if (unsafe && error instanceof ApiError && error.code === 'CSRF_TOKEN_INVALID') {
        this.#csrf = null;
        return this.#send<T>(method, path, options, await this.#csrfToken());
      }
      throw error;
    }
  }

  async #send<T>(method: HttpMethod, path: string, options: RequestOptions, csrf: string | null): Promise<T> {
    const url = new URL(path.replace(/^\//, ''), this.#base);
    const body = method === 'POST' || method === 'PATCH' ? JSON.stringify(options.body ?? {}) : '';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== '') headers['Content-Type'] = 'application/json';
    if (csrf !== null) headers['X-CSRF-Token'] = csrf;
    if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;
    if (options.platform) {
      const timestamp = String(this.clock.nowSeconds());
      const nonce = requestNonce();
      const canonical = canonicalRequest({
        method,
        path: `${url.pathname}${url.search}`,
        bodySha256Hex: await sha256Hex(body),
        timestamp,
        nonce,
        sessionId: options.platform.sessionId,
      });
      headers['X-Platform-Session'] = options.platform.token;
      headers['X-Session-Timestamp'] = timestamp;
      headers['X-Session-Nonce'] = nonce;
      headers['X-Session-Signature'] = await signP256(options.platform.key, canonical);
    }
    const response = await this.#fetch(url, {
      method,
      headers,
      credentials: 'include',
      ...(body === '' ? {} : { body }),
    });
    const text = await response.text();
    const parsed: unknown = text === '' ? null : JSON.parse(text);
    if (!response.ok) {
      const problem = (parsed ?? {}) as Problem;
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new ApiError(
        response.status,
        typeof problem.code === 'string' ? problem.code : `HTTP_${String(response.status)}`,
        typeof problem.title === 'string' ? problem.title : response.statusText,
        typeof problem.detail === 'string' ? problem.detail : null,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }
    if (parsed !== null && typeof parsed === 'object' && 'csrfToken' in parsed) {
      const token = (parsed as { csrfToken?: unknown }).csrfToken;
      if (typeof token === 'string') this.#csrf = token;
    }
    return parsed as T;
  }
}
