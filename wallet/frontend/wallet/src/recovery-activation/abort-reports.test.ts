// @vitest-environment jsdom
// Revisión de seguridad de ADR-033 (BAJO 6): el aviso de un pedido de R abortado (N10) no se pierde en silencio. Va con
// la sesión del propósito del pedido; si no llega (sin red, sesión vencida, la plataforma no responde), queda en la cola
// en memoria y sale con la próxima sesión válida de ese propósito (o se reintenta con la misma mientras siga vigente).
// Una respuesta definitiva del backend (404, 409, 400, 422) lo saca de la cola. Al dejar el pedido después de una
// comparación que no coincidió, el aviso firmado de antemano sale con `fetch` keepalive en `pagehide`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { ApiError, NetworkError } from '../api/problem.ts';
import type { PlatformAuth } from '../api/request-signature.ts';
import { AbortReports, rejectPath, type AbortSession, type PendingAbort } from './abort-reports.ts';

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const OTHER = '11111111-1111-4111-8111-111111111111';
const platform = (sessionId: string) => ({ token: `t-${sessionId}`, sessionId }) as PlatformAuth;
const onboarding = (sessionId = 's1', expiresAt?: string): AbortSession => ({
  platform: platform(sessionId),
  purpose: 'ONBOARDING',
  ...(expiresAt === undefined ? {} : { expiresAt }),
});
const abort = (overrides: Partial<PendingAbort> = {}): PendingAbort => ({
  enrollmentId: ID,
  reason: 'RETURN_LINK_UNVERIFIED',
  purpose: 'ONBOARDING',
  ...overrides,
});
const problem = (status: number, code: string) => new ApiError({ type: 'x', title: 't', status, code, requestId: 'r' });

interface Sent {
  path: string;
  sessionId: string;
  body: unknown;
}

/** Cliente de prueba: registra lo enviado y responde lo que diga `answer` (por pedido). */
function fakeClient(answer: (path: string, sessionId: string) => unknown = () => ({})) {
  const sent: Sent[] = [];
  const client = {
    request: (_method: string, path: string, options?: { platform?: PlatformAuth; body?: unknown }) => {
      const sessionId = options?.platform?.sessionId ?? '';
      sent.push({ path, sessionId, body: options?.body });
      const result = answer(path, sessionId);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
    prepare: vi.fn((_method: string, path: string, options?: { platform?: PlatformAuth; body?: unknown }) =>
      Promise.resolve({
        url: `https://api.example/api/v1${path}`,
        init: {
          method: 'POST',
          body: JSON.stringify(options?.body),
          headers: { 'X-Session-Nonce': crypto.randomUUID() },
        },
      }),
    ),
  };
  return { client: client as unknown as Pick<ApiClient, 'request' | 'prepare'>, sent, prepare: client.prepare };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('avisos de pedidos de R abortados', () => {
  it('con la sesión, el aviso sale enseguida con el motivo y deja la cola', async () => {
    const { client, sent } = fakeClient();
    const reports = new AbortReports(client);
    await reports.report(abort(), onboarding());
    expect(sent).toEqual([{ path: rejectPath(ID), sessionId: 's1', body: { reason: 'RETURN_LINK_UNVERIFIED' } }]);
    expect(reports.pending()).toEqual([]);
    // El primer motivo es el que vale.
    const later = new AbortReports(fakeClient(() => new NetworkError('sin red')).client);
    await later.report(abort(), onboarding());
    await later.report(abort({ reason: 'MANUAL_COMPARISON_FAILED' }));
    expect(later.pending()).toEqual([abort()]);
  });

  it('sin red o con la sesión vencida queda en la cola y sale con la próxima sesión del mismo propósito', async () => {
    let online = false;
    const { client, sent } = fakeClient((_path, sessionId) =>
      !online ? new NetworkError('sin red') : sessionId === 's2' ? problem(403, 'PLATFORM_SESSION_INVALID') : {},
    );
    const reports = new AbortReports(client);
    await reports.report(abort(), onboarding('s1'));
    expect(reports.pending()).toHaveLength(1);
    online = true;
    // La sesión s2 venció: no sirve, y no se prueba con los demás avisos.
    await reports.report(abort({ enrollmentId: OTHER, reason: 'MANUAL_COMPARISON_FAILED' }));
    await reports.flush(onboarding('s2'));
    expect(sent.filter((s) => s.sessionId === 's2')).toHaveLength(1);
    expect(reports.pending()).toHaveLength(2);
    // Una sesión de otro propósito no los manda.
    await reports.flush({ platform: platform('s3'), purpose: 'REPLACEMENT' });
    expect(sent.filter((s) => s.sessionId === 's3')).toEqual([]);
    // La próxima sesión ONBOARDING válida los manda a los dos.
    await reports.flush(onboarding('s4'));
    expect(sent.filter((s) => s.sessionId === 's4').map((s) => s.path)).toEqual([rejectPath(ID), rejectPath(OTHER)]);
    expect(reports.pending()).toEqual([]);
  });

  it('una respuesta definitiva del backend lo saca de la cola; uno de otro propósito espera la sesión que corresponde', async () => {
    const answers: Record<string, unknown> = {
      [rejectPath(ID)]: problem(409, 'CONFLICT'),
      [rejectPath(OTHER)]: problem(403, 'SCOPE_NOT_ALLOWED'),
    };
    const { client, sent } = fakeClient((path) => answers[path] ?? problem(404, 'NOT_FOUND'));
    const reports = new AbortReports(client);
    await reports.report(abort({ purpose: null }));
    await reports.report(abort({ enrollmentId: OTHER, purpose: null }));
    await reports.report(abort({ enrollmentId: 'otro', purpose: null }));
    await reports.flush(onboarding());
    // 409 y 404: decididos; SCOPE_NOT_ALLOWED (era de otro propósito): sigue, y se probó el siguiente igual.
    expect(sent.map((s) => s.path)).toEqual([rejectPath(ID), rejectPath(OTHER), rejectPath('otro')]);
    expect(reports.pending().map((p) => p.enrollmentId)).toEqual([OTHER]);
    answers[rejectPath(OTHER)] = {};
    await reports.flush({ platform: platform('ops'), purpose: 'REPLACEMENT' });
    expect(reports.pending()).toEqual([]);
  });

  it('con la plataforma caída se reintenta solo con la misma sesión mientras siga vigente', async () => {
    vi.useFakeTimers();
    let down = true;
    const { client, sent } = fakeClient(() => (down ? problem(503, 'SERVICE_UNAVAILABLE') : {}));
    const now = Date.parse('2026-10-19T12:00:00Z');
    const reports = new AbortReports(client, { retryMs: 15_000, now: () => now });
    await reports.report(abort(), onboarding('s1', '2026-10-19T12:10:00Z'));
    expect(sent).toHaveLength(1);
    down = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sent).toHaveLength(2);
    expect(reports.pending()).toEqual([]);
    // Con la sesión a punto de vencer no se programa el reintento: espera la próxima sesión.
    down = true;
    await reports.report(abort({ enrollmentId: OTHER }), onboarding('s1', '2026-10-19T12:00:30Z'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(3);
    expect(reports.pending()).toHaveLength(1);
  });

  it('al dejar el pedido: el aviso firmado de antemano sale con keepalive en pagehide, y se vuelve a firmar antes de vencer', async () => {
    vi.useFakeTimers();
    const { client, prepare } = fakeClient();
    const fetches: { url: string; init: RequestInit }[] = [];
    const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      fetches.push({ url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, init: init ?? {} });
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const reports = new AbortReports(client, { fetch: fetcher, rearmMs: 30_000 });
    const sent = vi.fn();
    const entry = abort({ reason: 'MANUAL_COMPARISON_FAILED' });
    reports.armOnLeave(entry, onboarding(), sent);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith('POST', rejectPath(ID), {
      platform: platform('s1'),
      body: { reason: 'MANUAL_COMPARISON_FAILED' },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(prepare).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event('pagehide'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetches[0]?.url).toBe(`https://api.example/api/v1${rejectPath(ID)}`);
    expect(fetches[0]?.init).toMatchObject({ method: 'POST', keepalive: true });
    const body = fetches[0]?.init.body;
    expect(JSON.parse(typeof body === 'string' ? body : '')).toEqual({ reason: 'MANUAL_COMPARISON_FAILED' });
    expect(sent).toHaveBeenCalledTimes(1);
    // Si la pestaña vuelve del bfcache, el pedido ya salió (y no se vuelve a mandar ni a firmar).
    await vi.advanceTimersByTimeAsync(0);
    expect(reports.pending()).toEqual([]);
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('desarmado (comparación confirmada o pedido nuevo), pagehide no manda nada; sin firma lista, queda en la cola', async () => {
    vi.useFakeTimers();
    const { client } = fakeClient();
    const fetcher = vi.fn(() => Promise.resolve(new Response('{}')));
    const reports = new AbortReports(client, { fetch: fetcher as unknown as typeof fetch });
    const disarm = reports.armOnLeave(abort(), onboarding(), () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    disarm();
    window.dispatchEvent(new Event('pagehide'));
    expect(fetcher).not.toHaveBeenCalled();
    expect(reports.pending()).toEqual([]);

    const failing = fakeClient();
    failing.prepare.mockImplementation(() => Promise.reject(new Error('sin sesión')));
    const unsigned = new AbortReports(failing.client, { fetch: fetcher as unknown as typeof fetch });
    const left = vi.fn();
    unsigned.armOnLeave(abort({ enrollmentId: OTHER }), onboarding(), left);
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event('pagehide'));
    expect(fetcher).not.toHaveBeenCalled();
    expect(left).toHaveBeenCalledTimes(1);
    expect(unsigned.pending().map((p) => p.enrollmentId)).toEqual([OTHER]);
  });
});
