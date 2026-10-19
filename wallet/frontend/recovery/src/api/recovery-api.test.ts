// P19: cada endpoint del listener de Recovery que usa la app sale con su método, ruta, cuerpo y protección: CSRF en los
// POST/DELETE, Idempotency-Key en los que crean operaciones y los headers firmados por la session key en los críticos
// (PlatformSession). La firma del canónico la cubre api.test.ts; acá, el contrato de cada llamada.
import { describe, expect, it } from 'vitest';
import { ApiClient, type PlatformAuth } from './client.ts';
import { RecoveryApi } from './recovery-api.ts';
import { generateSessionKey } from './session-key.ts';

interface Seen {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

function setup() {
  const seen: Seen[] = [];
  const fetcher: typeof fetch = (input, init = {}) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
    const headers = init.headers as Record<string, string>;
    if (url.pathname.endsWith('/auth/csrf')) return Promise.resolve(Response.json({ csrfToken: 'csrf-1' }));
    seen.push({
      method: init.method ?? 'GET',
      path: `${url.pathname}${url.search}`.replace('/api/v1', ''),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      headers,
    });
    return Promise.resolve(Response.json({}));
  };
  return { seen, api: new RecoveryApi(new ApiClient('http://localhost:8081/api/v1', { fetch: fetcher })) };
}

const WALLET = '7d2e3f40-1a2b-4c5d-8e9f-a0b1c2d3e4f5';
const OP = '11111111-2222-4333-8444-555555555555';
const SIGNATURE = `0x${'ab'.repeat(65)}` as const;

describe('RecoveryApi', () => {
  it('cuenta, step-up y PlatformSession', async () => {
    const { api, seen } = setup();
    const key = await generateSessionKey();
    const platform: PlatformAuth = { token: 'platform-token', sessionId: 'ps-1', key: key.privateKey };
    await api.login({ email: 'ana@example.test', password: 'x' });
    await api.logout();
    await api.me();
    await api.startStepUp({ scope: 'RECOVERY', sessionPublicKey: key.publicJwk, walletId: WALLET });
    await api.finishStepUp({ challengeId: 'c', code: '12345678' });
    await api.checkPlatformSession(platform);
    await api.revokePlatformSession('ps-1');
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /auth/login',
      'POST /auth/logout',
      'GET /users/me',
      'POST /platform-sessions/step-up/start',
      'POST /platform-sessions/step-up/finish',
      'POST /platform-sessions/check',
      'DELETE /platform-sessions/ps-1',
    ]);
    expect(seen[0]?.headers['X-CSRF-Token']).toBe('csrf-1');
    expect(seen[2]?.headers['X-CSRF-Token']).toBeUndefined();
    expect(seen[3]?.body).toMatchObject({ scope: 'RECOVERY', walletId: WALLET });
    expect(seen[5]?.headers).toMatchObject({ 'X-Platform-Session': 'platform-token' });
    expect(seen[5]?.headers['X-Session-Signature']).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  it('enrollment, rotaciones, operaciones, emergencia, migración y notificaciones', async () => {
    const { api, seen } = setup();
    const key = await generateSessionKey();
    const platform: PlatformAuth = { token: 't', sessionId: 'ps', key: key.privateKey };
    const envelope = { operationId: OP, safeTxHash: `0x${'11'.repeat(32)}` as const, sessionId: 'ps', submittedAt: 1 };
    await api.enrollment('e1');
    await api.registerEnrollmentKey(platform, 'e1', key.publicJwk);
    await api.submitEnrollment(platform, 'e1', { proofOfControl: '0x00' } as never);
    await api.rotations(WALLET);
    await api.proposeRotation(platform, WALLET, 'S', 'idem-propose');
    await api.prepareRotationExecution(platform, 'rot-1', 'idem-execute');
    await api.relayRotationCancellation('rot-1', SIGNATURE);
    await api.operations(WALLET, { limit: 20, before: OP });
    await api.operations(WALLET);
    await api.operation(OP);
    await api.submitSignature(
      platform,
      OP,
      { ownerSignature: SIGNATURE, submissionEnvelope: envelope, submissionEnvelopeSignature: 's' },
      'idem-sign',
    );
    await api.cancelOperation(platform, OP, 'idem-cancel');
    await api.whitelist(WALLET);
    await api.emergencyWhitelistRemove(platform, WALLET, '0x00000000000000000000000000000000000000d1');
    await api.emergencyNoop(platform, WALLET, OP);
    await api.emergencyRevokeApproval(platform, WALLET, 'USDT');
    await api.prepareMigration(platform, WALLET);
    await api.notifications({ limit: 5, unread: true });
    await api.notifications();
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET /recovery/enrollments/e1',
      'POST /recovery/enrollments/e1/enrollment-key',
      'POST /recovery/enrollments/e1/submit',
      `GET /wallets/${WALLET}/rotations`,
      `POST /wallets/${WALLET}/rotations`,
      'POST /rotations/rot-1/execute/prepare',
      'POST /rotations/rot-1/cancel',
      `GET /wallets/${WALLET}/operations?limit=20&before=${OP}`,
      `GET /wallets/${WALLET}/operations`,
      `GET /operations/${OP}`,
      `POST /operations/${OP}/signatures`,
      `POST /operations/${OP}/cancel`,
      `GET /wallets/${WALLET}/whitelist`,
      `POST /wallets/${WALLET}/emergency/whitelist-remove`,
      `POST /wallets/${WALLET}/emergency/noop`,
      `POST /wallets/${WALLET}/emergency/revoke-approval`,
      `POST /wallets/${WALLET}/migration/prepare`,
      'GET /notifications?limit=5&unread=true',
      'GET /notifications',
    ]);
    const byPath = (method: string, path: string) => seen.find((s) => s.method === method && s.path === path);
    expect(byPath('POST', `/wallets/${WALLET}/rotations`)).toMatchObject({
      body: { role: 'S' },
      headers: { 'Idempotency-Key': 'idem-propose' },
    });
    expect(byPath('POST', `/operations/${OP}/signatures`)?.body).toMatchObject({
      ownerRole: 'R',
      ownerSignature: SIGNATURE,
    });
    // La cancelación por relay va firmada por R (EIP-712): no necesita PlatformSession.
    expect(byPath('POST', '/rotations/rot-1/cancel')).toMatchObject({ body: { signature: SIGNATURE } });
    expect(byPath('POST', '/rotations/rot-1/cancel')?.headers['X-Platform-Session']).toBeUndefined();
    for (const path of ['whitelist-remove', 'noop', 'revoke-approval']) {
      const call = byPath('POST', `/wallets/${WALLET}/emergency/${path}`);
      expect(call?.headers['Idempotency-Key']).toMatch(/^rcv-/);
      expect(call?.headers['X-Platform-Session']).toBe('t');
    }
    expect(byPath('POST', `/wallets/${WALLET}/emergency/revoke-approval`)?.body).toEqual({ token: 'USDT' });
  });
});
