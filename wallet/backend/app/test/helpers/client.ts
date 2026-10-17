// Cliente HTTP de prueba con el comportamiento de un navegador sobre un listener: cookie jar (Set-Cookie con Max-Age),
// header Origin del frontend del listener y token CSRF (GET /auth/csrf antes del primer request no-GET y el que
// devuelven login/verificación al abrir una sesión).
import { randomInt } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import type { ApiInstance } from '../../src/api/server.ts';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface ParsedCookie {
  name: string;
  value: string;
  attributes: Record<string, string | true>;
}

export function parseSetCookie(header: string): ParsedCookie {
  const [pair = '', ...attrs] = header.split(';').map((p) => p.trim());
  const eq = pair.indexOf('=');
  const attributes: Record<string, string | true> = {};
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    if (i < 0) attributes[attr.toLowerCase()] = true;
    else attributes[attr.slice(0, i).toLowerCase()] = attr.slice(i + 1);
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes };
}

export function setCookies(response: LightMyRequestResponse): ParsedCookie[] {
  const raw = response.headers['set-cookie'];
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return list.map(parseSetCookie);
}

export interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export class TestClient {
  readonly jar = new Map<string, string>();
  csrf: string | null = null;
  /** Todo lo que este cliente mandó al servidor (inspección de payloads en los tests de seguridad). */
  readonly sent: SentRequest[] = [];
  readonly #app: ApiInstance;
  readonly origin: string;
  readonly remoteAddress: string;

  /** IP de origen aleatoria por cliente (TEST-NET-3): los buckets por IP de [B-RL] no se comparten entre tests. */
  constructor(app: ApiInstance, origin: string, remoteAddress = `203.0.113.${String(randomInt(1, 255))}`) {
    this.#app = app;
    this.origin = origin;
    this.remoteAddress = remoteAddress;
  }

  get cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(response: LightMyRequestResponse): void {
    for (const cookie of setCookies(response)) {
      const maxAge = cookie.attributes['max-age'];
      const expires = cookie.attributes.expires;
      const expired = maxAge === '0' || (typeof expires === 'string' && new Date(expires).getTime() < Date.now());
      if (expired || cookie.value === '') {
        this.jar.delete(cookie.name);
        // Sin sesión, el token CSRF atado a ella ya no sirve: el próximo request no-GET pide uno nuevo.
        if (cookie.name.endsWith('_sid')) this.csrf = null;
      } else {
        this.jar.set(cookie.name, cookie.value);
      }
    }
  }

  async refreshCsrf(): Promise<string> {
    const response = await this.#app.inject({
      method: 'GET',
      url: '/api/v1/auth/csrf',
      headers: { origin: this.origin, cookie: this.cookieHeader },
      remoteAddress: this.remoteAddress,
    });
    this.absorb(response);
    this.csrf = response.json<{ csrfToken: string }>().csrfToken;
    return this.csrf;
  }

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    if (UNSAFE.has(method) && this.csrf === null) await this.refreshCsrf();
    const headers: Record<string, string> = { origin: this.origin };
    if (this.jar.size > 0) headers.cookie = this.cookieHeader;
    if (UNSAFE.has(method) && this.csrf !== null) headers['x-csrf-token'] = this.csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    // Los headers explícitos del test reemplazan a los del navegador (p. ej. un Origin ajeno o un CSRF adulterado).
    Object.assign(headers, extraHeaders);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    this.sent.push({ method, url, headers: { ...headers }, body: payload });
    const response = await this.#app.inject({
      method,
      url,
      headers,
      remoteAddress: this.remoteAddress,
      ...(payload === undefined ? {} : { payload }),
    });
    this.absorb(response);
    if (response.statusCode < 300) {
      const contentType = response.headers['content-type'] ?? '';
      if (contentType.includes('json')) {
        const parsed = response.json<{ csrfToken?: unknown }>();
        if (typeof parsed.csrfToken === 'string') this.csrf = parsed.csrfToken;
      }
    }
    return response;
  }

  get(url: string, headers: Record<string, string> = {}) {
    return this.request('GET', url, undefined, headers);
  }

  post(url: string, body: unknown = {}, headers: Record<string, string> = {}) {
    return this.request('POST', url, body, headers);
  }

  patch(url: string, body: unknown, headers: Record<string, string> = {}) {
    return this.request('PATCH', url, body, headers);
  }

  delete(url: string, headers: Record<string, string> = {}) {
    return this.request('DELETE', url, undefined, headers);
  }
}
