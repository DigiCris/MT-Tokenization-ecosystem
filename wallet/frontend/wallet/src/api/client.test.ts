// P17.T01 [F-SES-01]/[F-SES-03]: mecánica del cliente sobre un fetch que registra cada request y responde lo que el
// backend respondería (la integración contra la API real la cubren los tests de navegador sobre el stack local):
// cookies incluidas, CSRF en memoria con un solo reintento, Idempotency-Key, firma de requests críticos y RFC 9457.
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, newIdempotencyKey } from './client.ts';
import { ApiError, NetworkError, isProblem, problemOf } from './problem.ts';
import { canonicalRequest, bodySha256Hex, criticalHeaders, ServerAlignedClock } from './request-signature.ts';
import { generateSessionKey, verifyP256 } from './session-key.ts';
import { WalletApi } from './wallet-api.ts';

/** Idempotency-Key fijo de prueba (armado en ejecución: no es un secreto, pero tiene forma de clave). */
const IDEMPOTENCY = ['clave', 'idempotente', '0001'].join('-');

const BASE = 'https://api-wallet.example/api/v1';

interface Recorded {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({ type: `about:blank#${code}`, title: code, status, code, requestId: 'req-1', ...extra }),
    {
      status,
      headers: {
        'Content-Type': 'application/problem+json',
        'X-Request-Id': 'req-1',
        ...(status === 429 ? { 'Retry-After': '7' } : {}),
      },
    },
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function server(handler: (request: Recorded, index: number) => Response | Promise<Response>) {
  const requests: Recorded[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const recorded: Recorded = {
      url: input instanceof Request ? input.url : input.toString(),
      init,
      headers: { ...(init.headers as Record<string, string>) },
    };
    requests.push(recorded);
    return handler(recorded, requests.length - 1);
  });
  return { requests, client: new ApiClient({ baseUrl: BASE, fetch: fetcher }), fetcher };
}

describe('ApiClient', () => {
  it('pide el token CSRF una vez, lo manda en los no-GET y toma el nuevo cuando la sesión rota', async () => {
    let csrf = 'anon-1';
    const { client, requests } = server(({ url }) => {
      if (url.endsWith('/auth/csrf')) return json({ csrfToken: csrf });
      if (url.endsWith('/auth/login')) {
        csrf = 'session-1';
        return json({ user: { id: 'u' }, csrfToken: 'session-1' });
      }
      return json({ ok: true });
    });
    const api = new WalletApi(client);
    await Promise.all([client.csrfToken(), client.csrfToken()]);
    await api.login({ email: 'a@b.test', password: 'secreta' });
    await client.request('POST', '/x');
    expect(requests.map((r) => [r.init.method, new URL(r.url).pathname, r.headers['X-CSRF-Token']])).toEqual([
      ['GET', '/api/v1/auth/csrf', undefined],
      ['POST', '/api/v1/auth/login', 'anon-1'],
      ['POST', '/api/v1/x', 'session-1'],
    ]);
    for (const r of requests) {
      expect(r.init).toMatchObject({
        credentials: 'include',
        mode: 'cors',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
    }
    expect(requests[1]?.headers['Content-Type']).toBe('application/json');
    expect(requests[1]?.init.body).toBe('{"email":"a@b.test","password":"secreta"}');
  });

  it('un CSRF_TOKEN_INVALID se reintenta una sola vez con token nuevo; el segundo rechazo se propaga', async () => {
    let tokens = 0;
    let rejections = 0;
    const { client, requests } = server(({ url, headers }) => {
      if (url.endsWith('/auth/csrf')) return json({ csrfToken: `t${String(++tokens)}` });
      if (headers['X-CSRF-Token'] === 't1' || rejections >= 1) {
        rejections++;
        return problem(403, 'CSRF_TOKEN_INVALID');
      }
      return json({ ok: true });
    });
    await expect(client.request('POST', '/a')).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' });
    expect(requests.filter((r) => r.url.endsWith('/a')).map((r) => r.headers['X-CSRF-Token'])).toEqual(['t1', 't2']);
    rejections = 0;
    tokens = 1;
    const ok = server(({ url, headers }) =>
      url.endsWith('/auth/csrf')
        ? json({ csrfToken: `t${String(++tokens)}` })
        : headers['X-CSRF-Token'] === 't2'
          ? problem(403, 'CSRF_TOKEN_INVALID')
          : json({ ok: 1 }),
    );
    await expect(ok.client.request('DELETE', '/b')).resolves.toEqual({ ok: 1 });
  });

  it('errores RFC 9457: código, detalle, Retry-After; cuerpos no válidos dan un problema sintético', async () => {
    const { client } = server(({ url }) => {
      if (url.endsWith('/auth/csrf')) return json({ csrfToken: 't' });
      if (url.endsWith('/rate')) return problem(429, 'RATE_LIMITED', { detail: 'esperá' });
      if (url.endsWith('/html')) return new Response('<html>', { status: 502 });
      if (url.endsWith('/auth')) return problem(401, 'UNAUTHENTICATED');
      return new Response('no json', { status: 200 });
    });
    const rate = await client.request('POST', '/rate').catch((e: unknown) => e);
    expect(rate).toBeInstanceOf(ApiError);
    expect(rate).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfter: 7, message: 'RATE_LIMITED: esperá' });
    await expect(client.request('GET', '/html')).rejects.toMatchObject({ status: 502, code: 'INTERNAL_ERROR' });
    await expect(client.request('GET', '/text')).rejects.toBeInstanceOf(NetworkError);
    await expect(client.request('GET', '/auth')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(isProblem({ type: 'x', title: 't', status: 400, code: 'C', requestId: 'r', errors: [{ path: 'a' }] })).toBe(
      false,
    );
    expect(problemOf(404, { code: 1 }, null)).toMatchObject({ code: 'UNEXPECTED_RESPONSE', requestId: '' });
  });

  it('un fallo de red o un timeout es NetworkError; un abort del llamador se propaga tal cual', async () => {
    const down = new ApiClient({
      baseUrl: BASE,
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(down.request('GET', '/x')).rejects.toThrow('no se pudo contactar a la API');
    const slow = new ApiClient({
      baseUrl: BASE,
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    await expect(slow.request('GET', '/x')).rejects.toThrow('la API no respondió a tiempo');
    const controller = new AbortController();
    const pending = slow.request('GET', '/x', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });

  it('Idempotency-Key válido en las rutas idempotentes y firma del request crítico sobre path, query y cuerpo', async () => {
    const key = await generateSessionKey();
    const { client, requests } = server(({ url }) =>
      url.endsWith('/auth/csrf') ? json({ csrfToken: 't' }) : json({ id: 'w' }, 201),
    );
    const api = new WalletApi(client);
    const platform = { token: 'jws', sessionId: '5c1f0e2d-3b4a-4c5d-9e6f-7a8b9c0d1e2f', key };
    await api.createWallet(platform, IDEMPOTENCY);
    await client.request('POST', '/wallets/abc/send/prepare?x=1', { platform, body: { amount: '1' } });
    const create = requests[1];
    expect(create?.headers['Idempotency-Key']).toBe(IDEMPOTENCY);
    const signed = requests[2];
    const canonical = canonicalRequest({
      method: 'POST',
      path: '/api/v1/wallets/abc/send/prepare?x=1',
      bodySha256Hex: await bodySha256Hex('{"amount":"1"}'),
      timestamp: Number(signed?.headers['X-Session-Timestamp']),
      nonce: signed?.headers['X-Session-Nonce'] ?? '',
      platformSessionId: platform.sessionId,
    });
    expect(signed?.headers['X-Platform-Session']).toBe('jws');
    expect(signed?.headers['X-Session-Nonce']).toMatch(/^[0-9a-f]{32}$/);
    expect(Math.abs(Number(signed?.headers['X-Session-Timestamp']) - Date.now() / 1000)).toBeLessThan(5);
    expect(await verifyP256(key.publicJwk, canonical, signed?.headers['X-Session-Signature'] ?? '')).toBe(true);
    await expect(client.request('POST', '/x', { idempotencyKey: 'corta' })).rejects.toThrow('Idempotency-Key');
    expect(newIdempotencyKey()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
    expect(() => new ApiClient({ baseUrl: `${BASE}?q=1` })).toThrow(TypeError);
    await expect(client.request('GET', 'sin-barra')).rejects.toThrow(TypeError);
  });

  it('prepare arma y firma el request sin mandarlo (para enviarlo después, p. ej. con keepalive en pagehide)', async () => {
    const key = await generateSessionKey();
    const { client, requests } = server(() => json({ csrfToken: 't' }));
    const platform = { token: 'jws', sessionId: '5c1f0e2d-3b4a-4c5d-9e6f-7a8b9c0d1e2f', key };
    const { url, init } = await client.prepare('POST', '/recovery/enrollments/e/reject', {
      platform,
      body: { reason: 'MANUAL_COMPARISON_FAILED' },
    });
    // Sólo se pidió el token CSRF: el request en sí no salió.
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(['/api/v1/auth/csrf']);
    expect(url).toBe(`${BASE}/recovery/enrollments/e/reject`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', mode: 'cors', redirect: 'error' });
    expect(init.signal).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers['X-CSRF-Token']).toBe('t');
    const canonical = canonicalRequest({
      method: 'POST',
      path: '/api/v1/recovery/enrollments/e/reject',
      bodySha256Hex: await bodySha256Hex('{"reason":"MANUAL_COMPARISON_FAILED"}'),
      timestamp: Number(headers['X-Session-Timestamp']),
      nonce: headers['X-Session-Nonce'] ?? '',
      platformSessionId: platform.sessionId,
    });
    expect(await verifyP256(key.publicJwk, canonical, headers['X-Session-Signature'] ?? '')).toBe(true);
    // Cada armado lleva su propio nonce (un solo uso).
    const again = await client.prepare('POST', '/recovery/enrollments/e/reject', { platform, body: {} });
    expect((again.init.headers as Record<string, string>)['X-Session-Nonce']).not.toBe(headers['X-Session-Nonce']);
  });

  it('DELETE sin cuerpo no manda Content-Type; logout descarta el token de la sesión', async () => {
    let n = 0;
    const { client, requests } = server(({ url }) => {
      if (url.endsWith('/auth/csrf')) return json({ csrfToken: `t${String(++n)}` });
      return new Response(null, { status: 204 });
    });
    const api = new WalletApi(client);
    await api.revokeSession('id/raro');
    await api.logout();
    await api.revokeSession('otra');
    expect(
      requests.map((r) => [new URL(r.url).pathname, r.headers['Content-Type'], r.headers['X-CSRF-Token']]),
    ).toEqual([
      ['/api/v1/auth/csrf', undefined, undefined],
      ['/api/v1/sessions/id%2Fraro', undefined, 't1'],
      ['/api/v1/auth/logout', 'application/json', 't1'],
      ['/api/v1/auth/csrf', undefined, undefined],
      ['/api/v1/sessions/otra', undefined, 't2'],
    ]);
  });
});

describe('reloj de las firmas alineado con el servidor', () => {
  it('estima la diferencia con la hora del servidor y la usa en X-Session-Timestamp', async () => {
    let local = Date.parse('2026-10-18T12:00:00Z');
    const clock = new ServerAlignedClock(() => local);
    clock.observe('2026-10-18T12:05:00Z');
    expect(clock.offsetMs).toBe(300_000);
    local += 1_000;
    expect(clock.now()).toBe(Date.parse('2026-10-18T12:05:01Z'));
    clock.observe('no es una fecha');
    expect(clock.offsetMs).toBe(300_000);
    const key = await generateSessionKey();
    const headers = await criticalHeaders({ token: 'jws', sessionId: 'ps', key }, 'POST', '/api/v1/x', '{}', clock);
    expect(headers['X-Session-Timestamp']).toBe(String(Date.parse('2026-10-18T12:05:01Z') / 1000));
  });

  it('el cliente expone la hora alineada y deriva lo observado a su reloj', () => {
    const clock = new ServerAlignedClock(() => 1_000_000);
    const client = new ApiClient({ baseUrl: 'https://api.example/api/v1', clock });
    client.observeServerTime(new Date(1_060_000).toISOString());
    expect(client.now()).toBe(1_060_000);
  });
});
