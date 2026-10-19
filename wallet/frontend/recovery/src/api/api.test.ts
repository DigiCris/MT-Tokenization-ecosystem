// P19.T01 [B-PSES-05/06]: el cliente del listener de Recovery contra los vectores de contracts/ (JCS del enrollment,
// canónico del request crítico y del sobre de envío, firmas P-256 P1363 y thumbprint RFC 7638) y su comportamiento con
// un fetch de prueba (CSRF renovado una vez, problemas RFC 9457, headers de un request crítico verificables).
import { describe, expect, it, vi } from 'vitest';
import p256Vectors from '../../test/vectors/wire/p256.json' with { type: 'json' };
import { ApiClient, ApiError, canonicalRequest, ServerClock, type PlatformAuth } from './client.ts';
import { canonicalize, CanonicalJsonError, type Json } from './jcs.ts';
import { generateSessionKey, jwkThumbprint, sha256Hex, verifyP256, type P256PublicJwk } from './session-key.ts';
import { signSubmission, submissionCanonical } from './submission.ts';

const jwk = (value: { kty: string; crv: string; x: string; y: string }) => value as P256PublicJwk;

describe('vectores [W-02] y [B-PSES-05/06]', () => {
  it('JCS del objeto del enrollment y su firma P-256 con la Enrollment Key del vector', async () => {
    const { enrollment } = p256Vectors;
    expect(canonicalize(enrollment.object as Json)).toBe(enrollment.canonical);
    expect(`0x${await sha256Hex(enrollment.canonical)}`).toBe(enrollment.sha256);
    expect(await jwkThumbprint(jwk(enrollment.publicJwk))).toBe(enrollment.jwkThumbprint);
    expect(await verifyP256(jwk(enrollment.publicJwk), enrollment.canonical, enrollment.signature)).toBe(true);
    expect(await verifyP256(jwk(enrollment.publicJwk), `${enrollment.canonical} `, enrollment.signature)).toBe(false);
  });

  it('canónico del request crítico: el mismo string que el backend firma y verifica', async () => {
    const { criticalRequest } = p256Vectors;
    const [, method, path, , timestamp, nonce, sessionId] = criticalRequest.canonical.split('\n');
    expect(
      canonicalRequest({
        method: method as 'POST',
        path: path ?? '',
        bodySha256Hex: await sha256Hex(criticalRequest.body),
        timestamp: timestamp ?? '',
        nonce: nonce ?? '',
        sessionId: sessionId ?? '',
      }),
    ).toBe(criticalRequest.canonical);
    expect(await verifyP256(jwk(criticalRequest.publicJwk), criticalRequest.canonical, criticalRequest.signature)).toBe(
      true,
    );
  });

  it('sobre de envío: MTW-SUBMIT-V1 + JCS, y la firma de la session key verifica', async () => {
    const { submissionEnvelope } = p256Vectors;
    const object = submissionEnvelope.object as Parameters<typeof submissionCanonical>[0];
    expect(submissionCanonical(object)).toBe(submissionEnvelope.canonical);
    expect(
      await verifyP256(jwk(submissionEnvelope.publicJwk), submissionEnvelope.canonical, submissionEnvelope.signature),
    ).toBe(true);
    const key = await generateSessionKey();
    const signed = await signSubmission(
      key.privateKey,
      { operationId: object.operationId, safeTxHash: object.safeTxHash, sessionId: object.sessionId },
      object.submittedAt,
    );
    expect(signed.submissionEnvelope).toEqual(object);
    expect(await verifyP256(key.publicJwk, submissionEnvelope.canonical, signed.submissionEnvelopeSignature)).toBe(
      true,
    );
  });

  it('JCS: claves por unidades UTF-16, sólo enteros seguros', () => {
    expect(canonicalize({ b: 1, a: [true, null, 'é'], A: { z: 'x', y: -3 } })).toBe(
      '{"A":{"y":-3,"z":"x"},"a":[true,null,"é"],"b":1}',
    );
    expect(() => canonicalize({ x: 1.5 })).toThrow(CanonicalJsonError);
    expect(() => canonicalize({ x: 2 ** 60 })).toThrow(CanonicalJsonError);
  });

  it('la session key nueva: privada no extraíble, firma que verifica con su JWK pública', async () => {
    const key = await generateSessionKey();
    expect(key.privateKey.extractable).toBe(false);
    expect(key.publicJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(await jwkThumbprint(key.publicJwk)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeFetch(responses: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
  const sent: Sent[] = [];
  const fn = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
    sent.push({
      url: input instanceof URL ? input.href : typeof input === 'string' ? input : input.url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    const next = responses.shift() ?? { status: 500 };
    return Promise.resolve(
      new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status,
        headers: next.headers ?? {},
      }),
    );
  });
  return { fn, sent };
}

describe('ApiClient', () => {
  it('pide el CSRF antes del primer POST, guarda el que devuelve el login y lo renueva una vez si se rechaza', async () => {
    const { fn, sent } = fakeFetch([
      { status: 200, body: { csrfToken: 'anon' } },
      { status: 200, body: { user: { id: 'u' }, csrfToken: 'session-1' } },
      { status: 403, body: { code: 'CSRF_TOKEN_INVALID', title: 'Token CSRF ausente o inválido' } },
      { status: 200, body: { csrfToken: 'session-2' } },
      { status: 202, body: { challengeId: 'c' } },
    ]);
    const client = new ApiClient('http://api.test/api/v1', { fetch: fn });
    await client.request('POST', '/auth/login', { body: { email: 'a@b.c', password: 'x' } });
    await client.request('POST', '/platform-sessions/step-up/start', { body: {} });
    expect(sent.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      'GET /api/v1/auth/csrf',
      'POST /api/v1/auth/login',
      'POST /api/v1/platform-sessions/step-up/start',
      'GET /api/v1/auth/csrf',
      'POST /api/v1/platform-sessions/step-up/start',
    ]);
    expect(sent[1]?.headers['X-CSRF-Token']).toBe('anon');
    expect(sent[2]?.headers['X-CSRF-Token']).toBe('session-1');
    expect(sent[4]?.headers['X-CSRF-Token']).toBe('session-2');
  });

  it('un problema RFC 9457 se vuelve ApiError con código, detalle y Retry-After', async () => {
    const { fn } = fakeFetch([
      {
        status: 429,
        body: { code: 'RATE_LIMITED', title: 'Demasiados requests', detail: 'esperá' },
        headers: { 'retry-after': '30' },
      },
    ]);
    const client = new ApiClient('http://api.test/api/v1', { fetch: fn });
    const error = await client.request('GET', '/users/me').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', detail: 'esperá', retryAfterSeconds: 30 });
  });

  it('un request crítico lleva token, timestamp alineado al servidor, nonce y la firma P-256 del canónico', async () => {
    const { fn, sent } = fakeFetch([
      { status: 200, body: { csrfToken: 'session' } },
      { status: 200, body: { ok: true } },
    ]);
    const clock = new ServerClock();
    clock.observe(new Date(Date.now() + 3_600_000).toISOString());
    const client = new ApiClient('http://api.test/api/v1', { fetch: fn, clock });
    const key = await generateSessionKey();
    const platform: PlatformAuth = {
      token: 'jws',
      sessionId: '5c1f0e2d-3b4a-4c5d-9e6f-7a8b9c0d1e2f',
      key: key.privateKey,
    };
    await client.request('POST', '/wallets/w/rotations?x=1', {
      body: { role: 'U' },
      platform,
      idempotencyKey: 'rcv-1',
    });
    const critical = sent[1];
    expect(critical?.headers).toMatchObject({ 'X-Platform-Session': 'jws', 'Idempotency-Key': 'rcv-1' });
    const timestamp = Number(critical?.headers['X-Session-Timestamp']);
    expect(Math.abs(timestamp - (Math.floor(Date.now() / 1000) + 3600))).toBeLessThanOrEqual(2);
    expect(critical?.headers['X-Session-Nonce']).toMatch(/^[0-9a-f]{32}$/);
    const canonical = canonicalRequest({
      method: 'POST',
      path: '/api/v1/wallets/w/rotations?x=1',
      bodySha256Hex: await sha256Hex(critical?.body ?? ''),
      timestamp: critical?.headers['X-Session-Timestamp'] ?? '',
      nonce: critical?.headers['X-Session-Nonce'] ?? '',
      sessionId: platform.sessionId,
    });
    expect(await verifyP256(key.publicJwk, canonical, critical?.headers['X-Session-Signature'] ?? '')).toBe(true);
  });
});
