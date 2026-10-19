// P20.T03 en el backend: el cliente del integrity monitor (atestaciones verificadas con la clave fijada, caché y última
// respuesta si el monitor cae), el registro en integrity_status con auditoría de INTEGRITY_MISMATCH y
// COOPERATION_PAUSED/RESUMED sin duplicados (también con dos registradores a la vez) y GET /platform/status.
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditWriter } from '../../src/audit/audit-writer.ts';
import { Secret } from '../../src/config/secret.ts';
import { cooperationState, IntegrityMonitorClient } from '../../src/integrity/monitor-client.ts';
import { IntegrityStatusRecorder } from '../../src/integrity/status-recorder.ts';
import { createLogger } from '../../src/observability/logger.ts';
import { createMetrics } from '../../src/observability/metrics.ts';
import { buildTestListener, type TestListener } from '../helpers/api.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const monitorKey = generateKeyPairSync('ed25519');
// Relojes alineados con el real: la ruta de estado usa la hora del proceso.
const T0 = Math.floor(Date.now() / 1000);
const logger = createLogger({ level: 'silent', service: 'test' });

function kid(publicKey: KeyObject): string {
  const { x } = publicKey.export({ format: 'jwk' }) as { x: string };
  return createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest('base64url');
}

function attest(
  app: 'WALLET' | 'RECOVERY',
  status: 'OK' | 'MISMATCH' | 'UNREACHABLE',
  observedAt: number,
  overrides: Record<string, unknown> = {},
  key = monitorKey,
): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${b64({ alg: 'EdDSA', kid: kid(key.publicKey) })}.${b64({
    platformId: 'mtw-local',
    app,
    environment: 'local',
    releaseId: `${app.toLowerCase()}-local-1`,
    manifestSha256: `0x${'ef'.repeat(32)}`,
    status,
    observedAt,
    expiresAt: observedAt + 300,
    ...overrides,
  })}`;
  return `${input}.${sign(null, Buffer.from(input), key.privateKey).toString('base64url')}`;
}

/** Monitor falso: responde lo que el test deja en `served` (o nada si `down`). */
async function fakeMonitor() {
  const state = { served: {} as Record<string, string>, down: false, hits: 0 };
  const server: Server = createServer((_req, res) => {
    state.hits++;
    if (state.down) {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ attestations: state.served }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('sin puerto');
  return {
    state,
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}

describe('IntegrityMonitorClient', () => {
  it('sólo entrega atestaciones verificadas; reutiliza la respuesta y, si el monitor cae, la última', async () => {
    const monitor = await fakeMonitor();
    const other = generateKeyPairSync('ed25519');
    monitor.state.served = {
      WALLET: attest('WALLET', 'OK', T0),
      RECOVERY: attest('RECOVERY', 'OK', T0, {}, other),
      EXTRA: attest('WALLET', 'OK', T0, { platformId: 'otra' }),
    };
    let now = T0 * 1000;
    const client = new IntegrityMonitorClient({
      url: monitor.url,
      publicKey: monitorKey.publicKey,
      platformId: 'mtw-local',
      environment: 'local',
      now: () => now,
    });
    const first = await client.attestations();
    expect(first.map((a) => a.attestation.app)).toEqual(['WALLET']);
    await client.attestations();
    expect(monitor.state.hits).toBe(1);
    now += 11_000;
    monitor.state.down = true;
    expect(await client.attestations()).toEqual(first);
    expect(await client.verify('no-es.un.jws')).toBeNull();
    expect(await client.verify(attest('WALLET', 'OK', T0, { environment: 'production' }))).toBeNull();
    await monitor.close();
  });

  it('estado de la cooperación con la regla del signer', () => {
    const ok = (app: 'WALLET' | 'RECOVERY', at: number, status: 'OK' | 'MISMATCH' | 'UNREACHABLE' = 'OK') => ({
      platformId: 'p',
      app,
      environment: 'local' as const,
      releaseId: 'r',
      manifestSha256: `0x${'0'.repeat(64)}`,
      status,
      observedAt: at,
      expiresAt: at + 300,
    });
    expect(cooperationState({ WALLET: ok('WALLET', T0), RECOVERY: ok('RECOVERY', T0) }, {}, T0 + 10)).toBe('ACTIVE');
    expect(cooperationState({ WALLET: ok('WALLET', T0) }, {}, T0)).toBe('PAUSED');
    expect(cooperationState({ WALLET: ok('WALLET', T0), RECOVERY: ok('RECOVERY', T0) }, {}, T0 + 301)).toBe('PAUSED');
    const unreachable = { WALLET: ok('WALLET', T0, 'UNREACHABLE'), RECOVERY: ok('RECOVERY', T0) };
    expect(cooperationState(unreachable, { WALLET: T0 - 600 }, T0 + 10)).toBe('DEGRADED');
    expect(cooperationState(unreachable, { WALLET: T0 - 1_000 }, T0 + 10)).toBe('PAUSED');
    expect(cooperationState({ WALLET: ok('WALLET', T0, 'MISMATCH'), RECOVERY: ok('RECOVERY', T0) }, {}, T0)).toBe(
      'PAUSED',
    );
  });
});

describe('registro de integridad, auditoría y GET /platform/status', () => {
  let db: TestDatabase;
  let listener: TestListener;
  let monitor: Awaited<ReturnType<typeof fakeMonitor>>;
  let now = T0 * 1000;
  const audit = new AuditWriter(new Secret(Buffer.alloc(32, 9)), createMetrics({ defaultMetrics: false }));

  beforeAll(async () => {
    db = await createTestDatabase();
    monitor = await fakeMonitor();
    listener = await buildTestListener({
      db,
      configOverrides: {
        INTEGRITY_MONITOR_URL: monitor.url,
        INTEGRITY_MONITOR_PUBLIC_KEY: monitorKey.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      },
    });
  });

  afterAll(async () => {
    await listener.close();
    await monitor.close();
    await db.close();
  });

  const recorder = () =>
    new IntegrityStatusRecorder({
      db: db.app,
      audit,
      client: new IntegrityMonitorClient({
        url: monitor.url,
        publicKey: monitorKey.publicKey,
        platformId: 'mtw-local',
        environment: 'local',
        cacheMs: 0,
        now: () => now,
      }),
      platformId: 'mtw-local',
      logger,
      now: () => now,
    });
  const events = async () =>
    (
      await db.app
        .selectFrom('audit_events')
        .select('event_type')
        .where('event_type', 'in', ['INTEGRITY_MISMATCH', 'COOPERATION_PAUSED', 'COOPERATION_RESUMED'])
        .orderBy('occurred_at')
        .execute()
    ).map((e) => e.event_type);
  const rows = async () =>
    await db.app.selectFrom('integrity_status').select(['app', 'status']).orderBy('id').execute();
  interface Status {
    cooperation: string;
    integrity: string;
    apps: { app: string; status: string | null }[];
  }
  const status = async (): Promise<Status> =>
    (await listener.app.inject({ method: 'GET', url: '/api/v1/platform/status' })).json<Status>();

  it('sin atestaciones registradas la cooperación figura pausada (fail-closed)', async () => {
    expect(await status()).toMatchObject({ integrity: 'MONITORED', cooperation: 'PAUSED' });
  });

  it('OK de las dos apps: dos filas, sin eventos, ACTIVE; repetir no duplica', async () => {
    monitor.state.served = { WALLET: attest('WALLET', 'OK', T0), RECOVERY: attest('RECOVERY', 'OK', T0) };
    expect(await recorder().tick()).toBe('ACTIVE');
    expect(await recorder().tick()).toBe('ACTIVE');
    expect(await rows()).toEqual([
      { app: 'WALLET', status: 'OK' },
      { app: 'RECOVERY', status: 'OK' },
    ]);
    expect(await events()).toEqual([]);
  });

  it('MISMATCH de Recovery: fila, INTEGRITY_MISMATCH y COOPERATION_PAUSED una sola vez aun con dos registradores', async () => {
    now += 60_000;
    monitor.state.served = {
      WALLET: attest('WALLET', 'OK', T0 + 60),
      RECOVERY: attest('RECOVERY', 'MISMATCH', T0 + 60),
    };
    const results = await Promise.all([recorder().tick(), recorder().tick()]);
    expect(results).toEqual(['PAUSED', 'PAUSED']);
    expect(await events()).toEqual(['INTEGRITY_MISMATCH', 'COOPERATION_PAUSED']);
    expect((await rows()).filter((r) => r.status === 'MISMATCH')).toHaveLength(1);
    const current = await status();
    expect(current.cooperation).toBe('PAUSED');
    expect(current.apps.find((a) => a.app === 'RECOVERY')?.status).toBe('MISMATCH');
  });

  it('el monitor vuelve a atestar OK: COOPERATION_RESUMED y ACTIVE', async () => {
    now += 60_000;
    monitor.state.served = { WALLET: attest('WALLET', 'OK', T0 + 120), RECOVERY: attest('RECOVERY', 'OK', T0 + 120) };
    expect(await recorder().tick()).toBe('ACTIVE');
    expect(await events()).toEqual(['INTEGRITY_MISMATCH', 'COOPERATION_PAUSED', 'COOPERATION_RESUMED']);
    expect((await status()).cooperation).toBe('ACTIVE');
  });

  it('estado estable: el latido mantiene vigente lo registrado y la cooperación sigue ACTIVE pasados 5 min', async () => {
    // El monitor renueva las atestaciones OK cada minuto sin cambiar de estado: lo registrado no puede quedar más viejo
    // que ATTESTATION_MAX_AGE_SECONDS, o /platform/status mostraría una pausa que el signer no aplica.
    for (let minute = 3; minute <= 9; minute += 1) {
      now = (T0 + minute * 60) * 1000;
      monitor.state.served = {
        WALLET: attest('WALLET', 'OK', T0 + minute * 60),
        RECOVERY: attest('RECOVERY', 'OK', T0 + minute * 60),
      };
      expect(await recorder().tick()).toBe('ACTIVE');
    }
    expect((await events()).at(-1)).toBe('COOPERATION_RESUMED');
  });

  it('monitor caído: al vencer las atestaciones la cooperación figura pausada', async () => {
    monitor.state.down = true;
    now += 400_000;
    expect(await recorder().tick()).toBe('PAUSED');
    expect((await events()).at(-1)).toBe('COOPERATION_PAUSED');
    monitor.state.down = false;
  });
});
