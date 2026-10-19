// Monitor de prueba contra uno o dos sitios de test/helpers/site.ts, con reloj controlado y archivo de estado propio.
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signApproval, type ResumeApproval } from '../../src/approvals.ts';
import type { App } from '../../src/check.ts';
import { IntegrityMonitor, type MonitorEvents } from '../../src/monitor.ts';
import { StateStore } from '../../src/state.ts';
import type { TestSite } from './site.ts';

export const PLATFORM_ID = 'mtw-test-platform';

export interface TestMonitor {
  monitor: IntegrityMonitor;
  attestationKey: { privateKey: KeyObject; publicKey: KeyObject };
  operators: Record<'ana' | 'beto' | 'carla', KeyObject>;
  stateFile: string;
  clock: { now: number };
  approval: (operator: 'ana' | 'beto' | 'carla', app: App, releaseId: string, manifestSha256: string) => ResumeApproval;
  /** Un monitor nuevo sobre el mismo archivo de estado (reinicio del contenedor). */
  restart: () => IntegrityMonitor;
}

export function startMonitor(sites: Partial<Record<App, TestSite>>, events: MonitorEvents = {}): TestMonitor {
  const attestationKey = generateKeyPairSync('ed25519');
  const operatorPairs = {
    ana: generateKeyPairSync('ed25519'),
    beto: generateKeyPairSync('ed25519'),
    carla: generateKeyPairSync('ed25519'),
  };
  const stateFile = join(mkdtempSync(join(tmpdir(), 'mtw-integrity-state-')), 'state.json');
  const clock = { now: Date.UTC(2026, 9, 18, 12) };
  const placeholder = generateKeyPairSync('ed25519').publicKey;
  const build = () =>
    new IntegrityMonitor({
      platformId: PLATFORM_ID,
      manifestEnvironment: 'local',
      attestationEnvironment: 'local',
      targets: (Object.entries(sites) as [App, TestSite][]).map(([app, site]) => ({ app, url: site.url })),
      releaseKeys: {
        WALLET: [sites.WALLET?.releaseKey.publicKey ?? placeholder],
        RECOVERY: [sites.RECOVERY?.releaseKey.publicKey ?? placeholder],
      },
      attestationKey: attestationKey.privateKey,
      operatorKeys: new Map(Object.entries(operatorPairs).map(([id, pair]) => [id, pair.publicKey])),
      attestationTtlSeconds: 300,
      fetchTimeoutMs: 3_000,
      state: new StateStore(stateFile),
      now: () => clock.now,
      events,
    });
  return {
    monitor: build(),
    attestationKey,
    operators: {
      ana: operatorPairs.ana.privateKey,
      beto: operatorPairs.beto.privateKey,
      carla: operatorPairs.carla.privateKey,
    },
    stateFile,
    clock,
    approval: (operator, app, releaseId, manifestSha256) =>
      signApproval(
        { operatorId: operator, app, releaseId, manifestSha256, issuedAt: Math.floor(clock.now / 1000) },
        { platformId: PLATFORM_ID, environment: 'local' },
        operatorPairs[operator].privateKey,
      ),
    restart: build,
  };
}
