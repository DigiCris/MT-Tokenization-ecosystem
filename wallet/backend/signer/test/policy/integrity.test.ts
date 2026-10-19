// P20.T03: la compuerta de integridad del signer (policy/integrity.ts) con atestaciones firmadas por una clave de
// monitor de prueba. Coopera sólo con atestaciones vigentes (≤ 5 min) de Wallet y Recovery; MISMATCH pausa en el acto y
// un OK más viejo que ese MISMATCH no reanuda; UNREACHABLE tiene 15 min de gracia desde el último OK; sin atestación
// (monitor caído) o vencida → pausa (fail-closed); se ignoran las de otra clave, plataforma o entorno, y las futuras.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ed25519Kid, pinnedKeys, signJws } from '../../src/crypto/jws.ts';
import { IntegrityGate, type IntegrityApp } from '../../src/policy/integrity.ts';

const monitor = generateKeyPairSync('ed25519');
const keys = pinnedKeys(monitor.publicKey);
const T0 = 1_792_400_000;
const context = (now: number) => ({ platformId: 'mtw', environment: 'staging', now, clockSkewSeconds: 60 });

function attest(
  app: IntegrityApp,
  status: 'OK' | 'MISMATCH' | 'UNREACHABLE',
  observedAt: number,
  overrides: Record<string, unknown> = {},
  key = monitor,
): string {
  return signJws(
    {
      platformId: 'mtw',
      app,
      environment: 'staging',
      releaseId: `${app.toLowerCase()}-staging-1`,
      manifestSha256: `0x${'cd'.repeat(32)}`,
      status,
      observedAt,
      expiresAt: observedAt + 300,
      ...overrides,
    },
    key.privateKey,
    ed25519Kid(key.publicKey),
  );
}

const both = (status: 'OK' | 'MISMATCH' | 'UNREACHABLE', at: number) => [
  attest('WALLET', status, at),
  attest('RECOVERY', 'OK', at),
];

describe('cooperación', () => {
  it('con las dos apps OK y vigentes', async () => {
    expect(await new IntegrityGate(keys).decide(both('OK', T0), context(T0 + 30))).toEqual({
      cooperate: true,
      degraded: [],
    });
  });

  it('sin atestaciones (monitor caído) o sólo de una app → pausa', async () => {
    const gate = new IntegrityGate(keys);
    expect(await gate.decide([], context(T0))).toMatchObject({ cooperate: false, app: 'WALLET', reason: 'MISSING' });
    expect(await gate.decide([attest('WALLET', 'OK', T0)], context(T0))).toMatchObject({
      cooperate: false,
      app: 'RECOVERY',
      reason: 'MISSING',
    });
  });

  it('vencida o con más de 5 min → pausa (STALE)', async () => {
    const gate = new IntegrityGate(keys);
    expect(await gate.decide(both('OK', T0), context(T0 + 301))).toMatchObject({ cooperate: false, reason: 'STALE' });
    const shortLived = [attest('WALLET', 'OK', T0, { expiresAt: T0 + 10 }), attest('RECOVERY', 'OK', T0)];
    expect(await gate.decide(shortLived, context(T0 + 11))).toMatchObject({
      cooperate: false,
      app: 'WALLET',
      reason: 'STALE',
    });
  });
});

describe('MISMATCH', () => {
  it('pausa en el acto; un OK más viejo (reenviado) no reanuda; uno posterior sí', async () => {
    const gate = new IntegrityGate(keys);
    expect((await gate.decide(both('OK', T0), context(T0))).cooperate).toBe(true);
    expect(await gate.decide(both('MISMATCH', T0 + 60), context(T0 + 60))).toMatchObject({
      cooperate: false,
      app: 'WALLET',
      reason: 'MISMATCH',
    });
    // Un atacante que reenvía el OK anterior (todavía dentro de los 5 min) no levanta la pausa.
    expect(await gate.decide(both('OK', T0), context(T0 + 90))).toMatchObject({ cooperate: false, reason: 'MISMATCH' });
    // Tampoco un UNREACHABLE mientras está pausada.
    expect(await gate.decide(both('UNREACHABLE', T0 + 120), context(T0 + 120))).toMatchObject({ reason: 'MISMATCH' });
    // El monitor vuelve a atestar OK (release restaurado y doble aprobación): se reanuda.
    expect(await gate.decide(both('OK', T0 + 180), context(T0 + 180))).toEqual({ cooperate: true, degraded: [] });
  });

  it('el MISMATCH gana aunque venga junto a un OK más viejo de la misma app', async () => {
    const tokens = [
      attest('WALLET', 'OK', T0),
      attest('WALLET', 'MISMATCH', T0 + 30),
      attest('RECOVERY', 'OK', T0 + 30),
    ];
    expect(await new IntegrityGate(keys).decide(tokens, context(T0 + 40))).toMatchObject({ reason: 'MISMATCH' });
  });
});

describe('UNREACHABLE', () => {
  it('coopera (degradado) hasta 15 min después del último OK y después pausa', async () => {
    const gate = new IntegrityGate(keys);
    await gate.decide(both('OK', T0), context(T0));
    expect(await gate.decide(both('UNREACHABLE', T0 + 600), context(T0 + 600))).toEqual({
      cooperate: true,
      degraded: ['WALLET'],
    });
    expect(await gate.decide(both('UNREACHABLE', T0 + 901), context(T0 + 901))).toMatchObject({
      cooperate: false,
      app: 'WALLET',
      reason: 'UNREACHABLE',
    });
  });

  it('sin un OK previo visto por este signer → pausa', async () => {
    expect(await new IntegrityGate(keys).decide(both('UNREACHABLE', T0), context(T0))).toMatchObject({
      cooperate: false,
      reason: 'UNREACHABLE',
    });
  });
});

describe('atestaciones que no cuentan', () => {
  it('otra clave, otra plataforma, otro entorno, del futuro o mal formadas', async () => {
    const other = generateKeyPairSync('ed25519');
    const ignored = [
      attest('WALLET', 'OK', T0, {}, other),
      attest('WALLET', 'OK', T0, { platformId: 'otra' }),
      attest('WALLET', 'OK', T0, { environment: 'production' }),
      attest('WALLET', 'OK', T0 + 3_600),
      attest('WALLET', 'OK', T0, { status: 'PERHAPS' }),
      'no.es.un-jws',
    ];
    expect(
      await new IntegrityGate(keys).decide([...ignored, attest('RECOVERY', 'OK', T0)], context(T0 + 5)),
    ).toMatchObject({
      cooperate: false,
      app: 'WALLET',
      reason: 'MISSING',
    });
  });

  it('sólo se miran las primeras 4', async () => {
    const filler = Array.from({ length: 4 }, () => attest('RECOVERY', 'OK', T0));
    expect(await new IntegrityGate(keys).decide([...filler, attest('WALLET', 'OK', T0)], context(T0))).toMatchObject({
      app: 'WALLET',
      reason: 'MISSING',
    });
  });
});
