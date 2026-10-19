// Configuración del monitor: claves por variable o por archivo (`_FILE`), targets (origins, https fuera de local, sin
// repetir apps), claves de release distintas por app, al menos dos operadores fuera de local y rangos numéricos.
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseTargets } from '../src/config.ts';

const spki = () => generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const pkcs8 = () =>
  generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    APP_ENV: 'local',
    PLATFORM_ID: 'mtw-local',
    MONITOR_TARGETS: 'WALLET=http://localhost:4173,RECOVERY=http://localhost:4174',
    WALLET_RELEASE_PUBLIC_KEY: spki(),
    RECOVERY_RELEASE_PUBLIC_KEY: spki(),
    MONITOR_ATTESTATION_PRIVATE_KEY: pkcs8(),
    MONITOR_STATE_FILE: '/tmp/mtw-integrity-state.json',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('local con valores por defecto', () => {
    const config = loadConfig(env());
    expect(config).toMatchObject({
      appEnv: 'local',
      manifestEnvironment: 'local',
      intervalSeconds: 60,
      attestationTtlSeconds: 300,
      host: '127.0.0.1',
      port: 8090,
      targets: [
        { app: 'WALLET', url: 'http://localhost:4173' },
        { app: 'RECOVERY', url: 'http://localhost:4174' },
      ],
    });
    expect(config.operatorKeys.size).toBe(0);
  });

  it('claves por archivo (PEM) y operadores', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mtw-integrity-config-'));
    const attestation = generateKeyPairSync('ed25519');
    writeFileSync(join(dir, 'attestation.pem'), attestation.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    writeFileSync(join(dir, 'operators.json'), JSON.stringify({ ana: spki(), beto: spki() }));
    const config = loadConfig(
      env({
        APP_ENV: 'staging',
        MONITOR_TARGETS: 'WALLET=https://wallet.mtw.test,RECOVERY=https://recovery.mtw.test',
        MONITOR_ATTESTATION_PRIVATE_KEY: undefined,
        MONITOR_ATTESTATION_PRIVATE_KEY_FILE: join(dir, 'attestation.pem'),
        MONITOR_OPERATOR_KEYS_FILE: join(dir, 'operators.json'),
        MONITOR_INTERVAL_SECONDS: '30',
      }),
    );
    expect([...config.operatorKeys.keys()]).toEqual(['ana', 'beto']);
    expect(config.intervalSeconds).toBe(30);
  });

  it('varias públicas de release por app durante una rotación (lista o PEM múltiple), nunca compartidas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mtw-integrity-keys-'));
    const pem = () => generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' });
    writeFileSync(join(dir, 'recovery.pub'), `${pem()}${pem()}`);
    const config = loadConfig(
      env({
        WALLET_RELEASE_PUBLIC_KEY: `${spki()},${spki()}`,
        RECOVERY_RELEASE_PUBLIC_KEY: undefined,
        RECOVERY_RELEASE_PUBLIC_KEY_FILE: join(dir, 'recovery.pub'),
      }),
    );
    expect(config.releaseKeys.WALLET).toHaveLength(2);
    expect(config.releaseKeys.RECOVERY).toHaveLength(2);
    const shared = spki();
    expect(() =>
      loadConfig(env({ WALLET_RELEASE_PUBLIC_KEY: `${spki()},${shared}`, RECOVERY_RELEASE_PUBLIC_KEY: shared })),
    ).toThrow('distintas');
    expect(() => loadConfig(env({ WALLET_RELEASE_PUBLIC_KEY: ' , ' }))).toThrow('no tiene ninguna clave pública');
  });

  it('rechazos', () => {
    const shared = spki();
    const cases: [Record<string, string | undefined>, string][] = [
      [{ APP_ENV: 'dev' }, 'APP_ENV tiene que ser local, staging o production'],
      [{ PLATFORM_ID: undefined }, 'falta PLATFORM_ID (o PLATFORM_ID_FILE)'],
      [{ WALLET_RELEASE_PUBLIC_KEY: shared, RECOVERY_RELEASE_PUBLIC_KEY: shared }, 'distintas'],
      [{ WALLET_RELEASE_PUBLIC_KEY: 'no-es-una-clave' }, 'WALLET_RELEASE_PUBLIC_KEY no es una clave pública válida'],
      [{ MONITOR_ATTESTATION_PRIVATE_KEY: spki() }, 'MONITOR_ATTESTATION_PRIVATE_KEY no es una clave privada válida'],
      [{ MONITOR_OPERATOR_KEYS: '[' }, 'MONITOR_OPERATOR_KEYS no es JSON'],
      [{ MONITOR_OPERATOR_KEYS: '[]' }, 'tiene que ser un objeto'],
      [{ MONITOR_OPERATOR_KEYS: JSON.stringify({ 'Ana Pérez': spki() }) }, 'entrada inválida'],
      [{ MONITOR_INTERVAL_SECONDS: '1' }, 'MONITOR_INTERVAL_SECONDS fuera de rango'],
      [
        {
          APP_ENV: 'production',
          MONITOR_TARGETS: 'WALLET=https://w.mtw.test',
          MONITOR_OPERATOR_KEYS: JSON.stringify({ ana: spki() }),
        },
        'al menos dos operadores',
      ],
    ];
    for (const [overrides, message] of cases) {
      expect(() => loadConfig(env(overrides)), message).toThrow(ConfigError);
      expect(() => loadConfig(env(overrides))).toThrow(message);
    }
    // Una clave RSA no es Ed25519.
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' });
    expect(() => loadConfig(env({ WALLET_RELEASE_PUBLIC_KEY: rsa.toString('base64') }))).toThrow('Ed25519');
  });
});

describe('parseTargets', () => {
  it('origins https fuera de local, sin rutas ni apps repetidas', () => {
    expect(() => parseTargets('WALLET=http://wallet.mtw.test', 'staging')).toThrow('sin https');
    expect(() => parseTargets('WALLET=https://wallet.mtw.test/app', 'staging')).toThrow('tiene que ser un origin');
    expect(() => parseTargets('WALLET=https://a.test,WALLET=https://b.test', 'staging')).toThrow('repite apps');
    expect(() => parseTargets('OTRA=https://a.test', 'staging')).toThrow('app desconocida');
    expect(() => parseTargets('WALLET=no es url', 'local')).toThrow('URL inválida');
    expect(parseTargets('RECOVERY=https://recovery.mtw.test/', 'production')).toEqual([
      { app: 'RECOVERY', url: 'https://recovery.mtw.test' },
    ]);
  });
});
