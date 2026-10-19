// P20.T04: después de un MISMATCH la reanudación exige el release otra vez OK y dos aprobaciones válidas de operadores
// distintos para ese release exacto. Un solo operador (aunque apruebe dos veces), una firma ajena, un release distinto,
// una aprobación vencida o un operador desconocido no reanudan; aprobar mientras el sitio sigue alterado se rechaza. Al
// reanudar, la atestación vuelve a OK y queda registrado quiénes aprobaron (también tras un reinicio).
import { afterEach, beforeEach, expect, it } from 'vitest';
import { signApproval } from '../src/approvals.ts';
import { ApprovalRejected } from '../src/monitor.ts';
import { verifyAttestation } from '../src/attestation.ts';
import { PLATFORM_ID, startMonitor, type TestMonitor } from './helpers/monitor.ts';
import { startSite, type TestSite } from './helpers/site.ts';

let site: TestSite;
let t: TestMonitor;
const resumed: string[][] = [];

beforeEach(async () => {
  site = await startSite({ app: 'wallet' });
  resumed.length = 0;
  t = startMonitor({ WALLET: site }, { resumed: (_app, operators) => resumed.push(operators) });
  site.write('favicon.svg', '<svg onload="alert(1)"/>');
  await t.monitor.runCycle();
  expect(t.monitor.status('WALLET').paused).toBe(true);
});

afterEach(async () => {
  await site.close();
});

function current() {
  const { releaseId } = t.monitor.status('WALLET');
  const token = t.monitor.attestations().WALLET ?? '';
  const attestation = verifyAttestation(token, t.attestationKey.publicKey);
  return { releaseId: releaseId ?? '', manifestSha256: attestation?.manifestSha256 ?? '', status: attestation?.status };
}

it('con el sitio todavía alterado, la aprobación se rechaza', () => {
  const { releaseId, manifestSha256 } = current();
  expect(() => t.monitor.approve(t.approval('ana', 'WALLET', releaseId, manifestSha256))).toThrow(ApprovalRejected);
});

it('release restaurado: un operador no alcanza, dos distintos reanudan', async () => {
  site.write('favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await t.monitor.runCycle();
  const { releaseId, manifestSha256, status } = current();
  expect(status).toBe('MISMATCH');

  expect(t.monitor.approve(t.approval('ana', 'WALLET', releaseId, manifestSha256))).toEqual({
    resumed: false,
    approvals: 1,
  });
  // El mismo operador otra vez no cuenta como segundo.
  expect(t.monitor.approve(t.approval('ana', 'WALLET', releaseId, manifestSha256))).toEqual({
    resumed: false,
    approvals: 1,
  });
  expect(current().status).toBe('MISMATCH');

  expect(t.monitor.approve(t.approval('beto', 'WALLET', releaseId, manifestSha256))).toEqual({
    resumed: true,
    approvals: 0,
  });
  expect(current().status).toBe('OK');
  expect(resumed).toEqual([['ana', 'beto']]);
  expect(t.monitor.status('WALLET')).toMatchObject({ paused: false, resumedBy: ['ana', 'beto'] });
  expect(t.restart().status('WALLET')).toMatchObject({
    paused: false,
    status: 'UNREACHABLE',
    resumedBy: ['ana', 'beto'],
  });
});

it('aprobaciones inválidas: firma ajena, otro release, vencida, futura u operador desconocido', async () => {
  site.write('favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await t.monitor.runCycle();
  const { releaseId, manifestSha256 } = current();
  const now = Math.floor(t.clock.now / 1000);
  const reject = (approval: Parameters<typeof t.monitor.approve>[0]) => {
    try {
      t.monitor.approve(approval);
      return 'aceptada';
    } catch (error) {
      return (error as Error).message;
    }
  };
  // Firmada por carla pero presentada como beto.
  const forged = { ...t.approval('carla', 'WALLET', releaseId, manifestSha256), operatorId: 'beto' };
  expect(reject(forged)).toBe('la firma de la aprobación no verifica');
  expect(reject(t.approval('beto', 'WALLET', 'otro-release', manifestSha256))).toBe('la aprobación es de otro release');
  expect(reject(t.approval('beto', 'WALLET', releaseId, `0x${'1'.repeat(64)}`))).toBe(
    'la aprobación es de otro release',
  );
  const context = { platformId: PLATFORM_ID, environment: 'local' };
  const old = signApproval(
    { operatorId: 'beto', app: 'WALLET', releaseId, manifestSha256, issuedAt: now - 3_601 },
    context,
    t.operators.beto,
  );
  expect(reject(old)).toBe('la aprobación venció');
  const future = signApproval(
    { operatorId: 'beto', app: 'WALLET', releaseId, manifestSha256, issuedAt: now + 3_600 },
    context,
    t.operators.beto,
  );
  expect(reject(future)).toBe('la aprobación tiene fecha futura');
  const stranger = signApproval(
    { operatorId: 'dario', app: 'WALLET', releaseId, manifestSha256, issuedAt: now },
    context,
    t.operators.carla,
  );
  expect(reject(stranger)).toBe('operador desconocido');
  // Para otra plataforma (contexto distinto) la firma no verifica.
  const otherPlatform = signApproval(
    { operatorId: 'beto', app: 'WALLET', releaseId, manifestSha256, issuedAt: now },
    { platformId: 'otra', environment: 'local' },
    t.operators.beto,
  );
  expect(reject(otherPlatform)).toBe('la firma de la aprobación no verifica');
  expect(t.monitor.status('WALLET').paused).toBe(true);
});

it('una app sin pausa no acepta aprobaciones', async () => {
  site.write('favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await t.monitor.runCycle();
  const { releaseId, manifestSha256 } = current();
  t.monitor.approve(t.approval('ana', 'WALLET', releaseId, manifestSha256));
  t.monitor.approve(t.approval('carla', 'WALLET', releaseId, manifestSha256));
  expect(() => t.monitor.approve(t.approval('beto', 'WALLET', releaseId, manifestSha256))).toThrow(
    'la app no está pausada',
  );
});
