// P20.T02 y P20.TST: el ciclo del monitor contra dos apps servidas. Atestaciones firmadas y vigentes con el formato
// [W-03]; un archivo alterado pausa en el primer ciclo después del cambio (≤ 2 ciclos); la pausa es pegajosa (restaurar
// el archivo no la levanta) y sobrevive a un reinicio; una firma de manifest inválida también pausa; un sitio caído es
// UNREACHABLE sin pausa; las atestaciones vencidas no se entregan.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyAttestation } from '../src/attestation.ts';
import { startMonitor, PLATFORM_ID, type TestMonitor } from './helpers/monitor.ts';
import { startSite, type TestSite } from './helpers/site.ts';

let wallet: TestSite;
let recovery: TestSite;
let t: TestMonitor;
const paused: string[] = [];

beforeEach(async () => {
  wallet = await startSite({ app: 'wallet' });
  recovery = await startSite({ app: 'recovery' });
  paused.length = 0;
  t = startMonitor({ WALLET: wallet, RECOVERY: recovery }, { paused: (app) => paused.push(app) });
});

afterEach(async () => {
  await wallet.close();
  await recovery.close();
});

const attested = (app: 'WALLET' | 'RECOVERY') => {
  const token = t.monitor.attestations()[app];
  return token === undefined ? null : verifyAttestation(token, t.attestationKey.publicKey);
};

describe('ciclo con las dos apps intactas', () => {
  it('atestaciones OK firmadas con la clave del monitor, con el formato [W-03]', async () => {
    await t.monitor.runCycle();
    const observedAt = Math.floor(t.clock.now / 1000);
    expect(attested('WALLET')).toEqual({
      platformId: PLATFORM_ID,
      app: 'WALLET',
      environment: 'local',
      releaseId: 'wallet-local-0000000000a1',
      manifestSha256: expect.stringMatching(/^0x[0-9a-f]{64}$/) as unknown,
      status: 'OK',
      observedAt,
      expiresAt: observedAt + 300,
    });
    expect(attested('RECOVERY')?.status).toBe('OK');
    expect(t.monitor.status('WALLET')).toMatchObject({ status: 'OK', paused: false, lastCheckStatus: 'OK' });
  });

  it('las atestaciones vencidas no se entregan', async () => {
    await t.monitor.runCycle();
    t.clock.now += 301_000;
    expect(t.monitor.attestations()).toEqual({});
  });
});

describe('pausa por MISMATCH', () => {
  it('un archivo alterado pausa en el ciclo siguiente (≤ 2 ciclos) y restaurarlo no reanuda', async () => {
    await t.monitor.runCycle();
    const original = recovery.read('assets/index-a1.js');
    recovery.write('assets/index-a1.js', `${original}fetch('https://attacker.example');\n`);
    t.clock.now += 60_000;
    await t.monitor.runCycle();
    expect(attested('RECOVERY')?.status).toBe('MISMATCH');
    expect(attested('WALLET')?.status).toBe('OK');
    expect(paused).toEqual(['RECOVERY']);
    expect(t.monitor.status('RECOVERY')).toMatchObject({
      paused: true,
      pauseProblems: ['assets/index-a1.js: el contenido no coincide con el manifest'],
    });

    recovery.write('assets/index-a1.js', original);
    t.clock.now += 60_000;
    await t.monitor.runCycle();
    expect(t.monitor.status('RECOVERY')).toMatchObject({ lastCheckStatus: 'OK', paused: true, status: 'MISMATCH' });
    expect(attested('RECOVERY')?.status).toBe('MISMATCH');
  });

  it('la pausa sobrevive a un reinicio del monitor', async () => {
    wallet.write('favicon.svg', '<svg/>');
    await t.monitor.runCycle();
    expect(t.monitor.status('WALLET').paused).toBe(true);
    const restarted = t.restart();
    expect(restarted.status('WALLET')).toMatchObject({ paused: true, status: 'MISMATCH' });
    wallet.write('favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await restarted.runCycle();
    expect(restarted.status('WALLET')).toMatchObject({ paused: true, status: 'MISMATCH', lastCheckStatus: 'OK' });
  });

  it('una firma de manifest inválida pausa', async () => {
    wallet.write('.well-known/release-manifest.json.sig', Buffer.alloc(64, 7).toString('base64'));
    await t.monitor.runCycle();
    expect(attested('WALLET')?.status).toBe('MISMATCH');
    expect(t.monitor.status('WALLET').pauseProblems).toEqual([
      'la firma del manifest no verifica con la clave de release fijada',
    ]);
  });
});

describe('UNREACHABLE', () => {
  it('un sitio caído se atesta UNREACHABLE sin pausar', async () => {
    await t.monitor.runCycle();
    await recovery.close();
    t.clock.now += 60_000;
    await t.monitor.runCycle();
    expect(attested('RECOVERY')?.status).toBe('UNREACHABLE');
    expect(t.monitor.status('RECOVERY').paused).toBe(false);
    recovery = await startSite({ app: 'recovery' });
  });
});
