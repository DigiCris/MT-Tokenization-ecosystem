// API interna del monitor: atestaciones vigentes, estado por app, aprobaciones de reanudación por HTTP (400 si no
// tienen el formato, 409 si no valen, 202 al aceptarlas), health y métricas Prometheus del estado de integridad.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildServer, createMetrics } from '../src/server.ts';
import { verifyAttestation } from '../src/attestation.ts';
import { startMonitor, type TestMonitor } from './helpers/monitor.ts';
import { startSite, type TestSite } from './helpers/site.ts';

let site: TestSite;
let t: TestMonitor;
let metrics: ReturnType<typeof createMetrics>;

beforeEach(async () => {
  site = await startSite({ app: 'recovery' });
  metrics = createMetrics();
  t = startMonitor(
    { RECOVERY: site },
    {
      checked: (app, result, attested) => {
        metrics.observe(app, result.status, attested.status, t.monitor.status(app).paused);
      },
    },
  );
});

afterEach(async () => {
  await site.close();
});

it('atestaciones, estado, health y métricas', async () => {
  const server = buildServer(t.monitor, metrics);
  expect((await server.inject({ url: '/v1/attestations' })).json()).toEqual({ attestations: {} });
  await t.monitor.runCycle();
  const { attestations } = (await server.inject({ url: '/v1/attestations' })).json<{
    attestations: Record<string, string>;
  }>();
  expect(verifyAttestation(attestations.RECOVERY ?? '', t.attestationKey.publicKey)?.status).toBe('OK');
  const status = (await server.inject({ url: '/v1/status' })).json<{ apps: { app: string; status: string }[] }>();
  expect(status.apps.find((a) => a.app === 'RECOVERY')).toMatchObject({ status: 'OK' });
  expect((await server.inject({ url: '/health' })).json()).toEqual({ status: 'ok' });
  const exposed = (await server.inject({ url: '/metrics' })).body;
  expect(exposed).toContain('mtw_integrity_status{app="RECOVERY"} 0');
  expect(exposed).toContain('mtw_integrity_paused{app="RECOVERY"} 0');
  await server.close();
});

it('aprobaciones por HTTP: formato inválido, rechazo y reanudación', async () => {
  const server = buildServer(t.monitor, metrics);
  site.write('favicon.svg', '<svg/>');
  await t.monitor.runCycle();
  expect((await server.inject({ url: '/metrics' })).body).toContain('mtw_integrity_paused{app="RECOVERY"} 1');
  site.write('favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await t.monitor.runCycle();
  const token = t.monitor.attestations().RECOVERY ?? '';
  const attestation = verifyAttestation(token, t.attestationKey.publicKey);
  const releaseId = attestation?.releaseId ?? '';
  const manifestSha256 = attestation?.manifestSha256 ?? '';

  expect(
    (await server.inject({ method: 'POST', url: '/v1/resume-approvals', payload: { app: 'RECOVERY' } })).statusCode,
  ).toBe(400);
  const wrong = await server.inject({
    method: 'POST',
    url: '/v1/resume-approvals',
    payload: t.approval('ana', 'RECOVERY', 'otro-release', manifestSha256),
  });
  expect(wrong.statusCode).toBe(409);
  expect(wrong.json()).toEqual({ error: 'APPROVAL_REJECTED', reason: 'la aprobación es de otro release' });
  const first = await server.inject({
    method: 'POST',
    url: '/v1/resume-approvals',
    payload: t.approval('ana', 'RECOVERY', releaseId, manifestSha256),
  });
  expect(first.statusCode).toBe(202);
  expect(first.json()).toEqual({ resumed: false, approvals: 1 });
  const second = await server.inject({
    method: 'POST',
    url: '/v1/resume-approvals',
    payload: t.approval('carla', 'RECOVERY', releaseId, manifestSha256),
  });
  expect(second.json()).toEqual({ resumed: true, approvals: 0 });
  await server.close();
});
