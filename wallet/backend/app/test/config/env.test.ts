// P08.T02: configuración por APP_ENV — faltantes, formatos inválidos, valores de ejemplo, baja entropía, forma _FILE
// obligatoria en staging/production y errores que nunca muestran valores.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadAuditVerifyConfig,
  loadConfig,
  loadMigrationConfig,
  SECRET_VARS,
} from '../../src/config/env.ts';
import { localEnv, randomKey32, testOpaqueServerSetup } from '../helpers/config.ts';

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('se esperaba ConfigError');
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mtw-config-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function secretFile(name: string, value: string): string {
  const path = join(dir, `${name}-${randomBytes(4).toString('hex')}`);
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  return path;
}

/** Entorno de producción válido: secretos por archivo, https, quórum dual y finalidad por tags. */
function productionEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const files: Record<string, string> = {
    DATABASE_URL: `postgres://mtw_app:${randomBytes(24).toString('hex')}@postgres:5432/mtw_wallet`,
    REDIS_URL: `redis://:${randomBytes(24).toString('hex')}@valkey:6379/0`,
    RPC_PRIMARY_URL: `https://base-mainnet.g.alchemy.com/v2/${randomBytes(16).toString('hex')}`,
    RPC_SECONDARY_URL: `https://wispy-fragrant.base-mainnet.quiknode.pro/${randomBytes(20).toString('hex')}/`,
    AUDIT_CHAIN_KEY: randomKey32(),
    SESSION_SECRET: randomKey32(),
    CSRF_SECRET: randomKey32(),
    APP_FIELD_ENCRYPTION_KEY: randomKey32(),
    OTP_HMAC_KEY: randomKey32(),
    PASSWORD_PEPPER_V1: randomKey32(),
    SESSION_ISSUER_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    EMAIL_PROVIDER_API_KEY: randomBytes(24).toString('hex'),
    OPAQUE_SERVER_SETUP: testOpaqueServerSetup(),
  };
  const env: Record<string, string | undefined> = {
    APP_ENV: 'production',
    PLATFORM_ID: 'mt-default',
    CHAIN_ID: '8453',
    API_BIND_HOST: '0.0.0.0',
    API_PUBLIC_URL_WALLET: 'https://api.wallet.mtw-prod.test',
    API_PUBLIC_URL_RECOVERY: 'https://api.recovery.mtw-prod.test',
    WALLET_ORIGIN: 'https://wallet.mtw-prod.test',
    RECOVERY_ORIGIN: 'https://recovery.mtw-prod.test',
    RPC_QUORUM_MODE: 'dual',
    CONFIRMATION_POLICY: 'tags',
    EMAIL_PROVIDER: 'mailgun',
    EMAIL_PROVIDER_DOMAIN: 'mail.mtw-prod.test',
    EMAIL_FROM: 'no-reply@mail.mtw-prod.test',
    SESSION_ISSUER_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    // Integrity monitor en la red interna del backend (P20): obligatorio fuera de local.
    INTEGRITY_MONITOR_URL: 'http://integrity-monitor:8092',
    INTEGRITY_MONITOR_PUBLIC_KEY: generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64'),
  };
  for (const [name, value] of Object.entries(files)) env[`${name}_FILE`] = secretFile(name, value);
  return { ...env, ...overrides };
}

describe('configuración local', () => {
  it('carga una configuración válida y nunca serializa secretos', () => {
    const env = localEnv();
    const config = loadConfig({ env, envFile: null });
    expect(config.appEnv).toBe('local');
    expect(config.chainId).toBe(8453);
    expect(config.api.walletPort).toBe(8080);
    expect(config.api.recoveryPort).toBe(8081);
    expect(config.api.docsTryItOut).toBe(true);
    expect(config.api.rateLimitGlobalPerMinute).toBe(1_000);
    expect(config.secrets.passwordPeppers.get(1)?.reveal()).toHaveLength(32);
    expect(String(config.secrets.auditChainKey)).toBe('[REDACTED]');
    const serialized = JSON.stringify(config) + inspect(config, { depth: 10 });
    for (const name of [...SECRET_VARS, 'PASSWORD_PEPPER_V1']) {
      const value = env[name];
      if (value) expect(serialized).not.toContain(value);
    }
  });

  it('OPAQUE_SERVER_SETUP: obligatorio y con el formato de un ServerSetup', () => {
    const missing = configError(() => loadConfig({ env: localEnv({ OPAQUE_SERVER_SETUP: undefined }), envFile: null }));
    expect(missing.problems.some((p) => p.startsWith('OPAQUE_SERVER_SETUP: falta'))).toBe(true);
    const short = configError(() => loadConfig({ env: localEnv({ OPAQUE_SERVER_SETUP: 'abc' }), envFile: null }));
    expect(short.problems).toContain(
      'OPAQUE_SERVER_SETUP: debe ser un ServerSetup de OPAQUE (128 bytes en base64url, pnpm opaque:setup)',
    );
  });

  it('falla si falta una variable obligatoria', () => {
    const error = configError(() => loadConfig({ env: localEnv({ DATABASE_URL: undefined }), envFile: null }));
    expect(error.problems.some((p) => p.startsWith('DATABASE_URL:'))).toBe(true);
  });

  it('falla con APP_ENV inválido', () => {
    const error = configError(() => loadConfig({ env: localEnv({ APP_ENV: 'prod' }), envFile: null }));
    expect(error.problems).toEqual(['APP_ENV: debe ser local, staging o production']);
  });

  it.each([
    ['CHAIN_ID', '1', 'debe ser 8453'],
    ['WALLET_ORIGIN', 'http://localhost:5173/app', 'debe ser un origin'],
    ['API_WALLET_PORT', 'abc', 'debe ser un puerto'],
    ['PLATFORM_ID', 'Mt Default', 'identificador'],
    ['RPC_QUORUM_MODE', 'triple', 'local-single o dual'],
    ['TRUST_PROXY', 'true', 'false, un entero'],
  ])('rechaza %s con formato inválido', (name, value, fragment) => {
    const error = configError(() => loadConfig({ env: localEnv({ [name]: value }), envFile: null }));
    expect(error.problems.find((p) => p.startsWith(`${name}:`))).toContain(fragment);
  });

  it('rechaza claves de ejemplo y de baja entropía, sin mostrar el valor', () => {
    const zeros = Buffer.alloc(32).toString('base64');
    const pattern = Buffer.from('ab'.repeat(16)).toString('base64');
    const error = configError(() =>
      loadConfig({
        env: localEnv({ AUDIT_CHAIN_KEY: zeros, CSRF_SECRET: 'changeme', OTP_HMAC_KEY: pattern }),
        envFile: null,
      }),
    );
    expect(error.problems).toContain('AUDIT_CHAIN_KEY: tiene baja entropía');
    expect(error.problems).toContain('CSRF_SECRET: es un valor de ejemplo');
    expect(error.problems).toContain('OTP_HMAC_KEY: tiene baja entropía');
    expect(error.message).not.toContain(zeros);
    expect(error.message).not.toContain(pattern);
  });

  it('rechaza passwords débiles embebidos en URLs de conexión', () => {
    const weak = 'postgres://mtw_app:password123@127.0.0.1:55432/mtw_wallet';
    const error = configError(() => loadConfig({ env: localEnv({ DATABASE_URL: weak }), envFile: null }));
    expect(error.problems.find((p) => p.startsWith('DATABASE_URL:'))).toMatch(
      /password (es demasiado corto|tiene baja entropía|es un valor de ejemplo)/,
    );
    expect(error.message).not.toContain('password123');
  });

  it('rechaza la clave Ed25519 de ejemplo de RFC 8032 y un par que no corresponde', () => {
    // PKCS#8 de la clave privada del vector 1 de RFC 8032 (pública en la especificación).
    const rfcKey = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      // Armado en tiempo de ejecución: sin literales con forma de credencial en el repositorio.
      Buffer.from(['9d61b19deffd5a60ba844af492ec2cc4', '4449c5697b326919703bac031cae7f60'].join(''), 'hex'),
    ]).toString('base64');
    const rfc = configError(() => loadConfig({ env: localEnv({ SESSION_ISSUER_PRIVATE_KEY: rfcKey }), envFile: null }));
    expect(rfc.problems).toContain('SESSION_ISSUER_PRIVATE_KEY: es la clave de ejemplo de RFC 8032');

    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const mismatch = configError(() =>
      loadConfig({ env: localEnv({ SESSION_ISSUER_PUBLIC_KEY: other }), envFile: null }),
    );
    expect(mismatch.problems).toContain('SESSION_ISSUER_PUBLIC_KEY: no corresponde a SESSION_ISSUER_PRIVATE_KEY');
  });

  it('exige claves simétricas distintas entre sí y puertos distintos', () => {
    const key = randomKey32();
    const error = configError(() =>
      loadConfig({ env: localEnv({ AUDIT_CHAIN_KEY: key, CSRF_SECRET: key, METRICS_PORT: '8080' }), envFile: null }),
    );
    expect(error.problems).toContain('AUDIT_CHAIN_KEY: las claves simétricas deben ser distintas entre sí');
    expect(error.problems.some((p) => p.includes('deben ser distintos'))).toBe(true);
  });

  it('carga peppers versionados y exige PASSWORD_PEPPER_V1', () => {
    const config = loadConfig({ env: localEnv({ PASSWORD_PEPPER_V2: randomKey32() }), envFile: null });
    expect([...config.secrets.passwordPeppers.keys()].sort()).toEqual([1, 2]);
    const error = configError(() => loadConfig({ env: localEnv({ PASSWORD_PEPPER_V1: undefined }), envFile: null }));
    expect(error.problems).toContain('PASSWORD_PEPPER_V1: falta');
  });

  it('acepta secretos desde <VAR>_FILE (ruta relativa a wallet/ sólo en local) y rechaza ambas formas a la vez', () => {
    const key = randomKey32();
    const config = loadConfig({
      env: localEnv({ AUDIT_CHAIN_KEY: undefined, AUDIT_CHAIN_KEY_FILE: secretFile('audit', key) }),
      envFile: null,
    });
    expect(config.secrets.auditChainKey.reveal().toString('base64')).toBe(key);

    const both = configError(() =>
      loadConfig({ env: localEnv({ AUDIT_CHAIN_KEY_FILE: secretFile('audit', randomKey32()) }), envFile: null }),
    );
    expect(both.problems).toContain('AUDIT_CHAIN_KEY: definida a la vez como AUDIT_CHAIN_KEY y AUDIT_CHAIN_KEY_FILE');

    const missing = configError(() =>
      loadConfig({
        env: localEnv({ AUDIT_CHAIN_KEY: undefined, AUDIT_CHAIN_KEY_FILE: join(dir, 'no-existe') }),
        envFile: null,
      }),
    );
    expect(missing.problems).toContain('AUDIT_CHAIN_KEY_FILE: el archivo no se puede leer');
  });

  it('completa desde wallet/.env en local y lo ignora en producción', () => {
    const env = localEnv();
    const lines = Object.entries(env)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}='${String(v)}'  # comentario`);
    const envFile = join(dir, '.env');
    writeFileSync(envFile, `# archivo de prueba\n${lines.join('\n')}\n`);
    const config = loadConfig({ env: {}, envFile });
    expect(config.platformId).toBe('mt-test');

    const prod = configError(() => loadConfig({ env: { APP_ENV: 'production' }, envFile }));
    expect(prod.problems.some((p) => p.startsWith('DATABASE_URL:'))).toBe(true);
  });
});

describe('configuración de staging y producción', () => {
  it('carga producción con todos los secretos por archivo', () => {
    const config = loadConfig({ env: productionEnv(), envFile: null });
    expect(config.appEnv).toBe('production');
    expect(config.api.docsTryItOut).toBe(false);
    expect(config.api.rateLimitGlobalPerMinute).toBe(300);
    expect(config.rpc.quorumMode).toBe('dual');
    expect(config.integrity).toMatchObject({ required: true, monitorUrl: 'http://integrity-monitor:8092' });
  });

  it('exige el integrity monitor y la integridad (fail-closed, P20)', () => {
    const error = configError(() =>
      loadConfig({
        env: productionEnv({
          INTEGRITY_REQUIRED: 'false',
          INTEGRITY_MONITOR_URL: undefined,
          INTEGRITY_MONITOR_PUBLIC_KEY: undefined,
        }),
        envFile: null,
      }),
    );
    expect(error.problems).toEqual(
      expect.arrayContaining([
        'INTEGRITY_REQUIRED: en production debe ser true (fail-closed)',
        'INTEGRITY_MONITOR_PUBLIC_KEY: falta (la clave pública del integrity monitor)',
        'INTEGRITY_MONITOR_URL: falta',
      ]),
    );
  });

  it('exige la forma _FILE para cada secreto (ADR-030)', () => {
    const error = configError(() =>
      loadConfig({
        env: productionEnv({ AUDIT_CHAIN_KEY: randomKey32(), AUDIT_CHAIN_KEY_FILE: undefined }),
        envFile: null,
      }),
    );
    expect(error.problems).toContain(
      'AUDIT_CHAIN_KEY: en production los secretos se leen sólo de AUDIT_CHAIN_KEY_FILE (ADR-030)',
    );
  });

  it('rechaza valores de ejemplo en producción', () => {
    const error = configError(() =>
      loadConfig({ env: productionEnv({ CSRF_SECRET_FILE: secretFile('csrf', 'changeme') }), envFile: null }),
    );
    expect(error.problems).toContain('CSRF_SECRET: es un valor de ejemplo');
  });

  it('exige rutas absolutas para los archivos de secretos', () => {
    const error = configError(() =>
      loadConfig({ env: productionEnv({ OTP_HMAC_KEY_FILE: 'secrets/otp' }), envFile: null }),
    );
    expect(error.problems).toContain('OTP_HMAC_KEY_FILE: en production debe ser una ruta absoluta');
  });

  it.each([
    ['RPC_QUORUM_MODE', 'local-single', 'debe ser dual'],
    ['CONFIRMATION_POLICY', 'depth', 'debe ser tags'],
    ['WALLET_ORIGIN', 'http://wallet.mtw-prod.test', 'debe usar https'],
    ['API_PUBLIC_URL_RECOVERY', 'https://localhost:8081', 'host local'],
  ])('en staging rechaza %s=%s', (name, value, fragment) => {
    const error = configError(() =>
      loadConfig({ env: productionEnv({ APP_ENV: 'staging', [name]: value }), envFile: null }),
    );
    expect(error.problems.find((p) => p.startsWith(`${name}:`))).toContain(fragment);
  });

  it('exige proveedores RPC remotos, con credencial y distintos entre sí', () => {
    const local = configError(() =>
      loadConfig({
        env: productionEnv({ RPC_PRIMARY_URL_FILE: secretFile('rpc', 'http://127.0.0.1:8545') }),
        envFile: null,
      }),
    );
    expect(local.problems).toContain('RPC_PRIMARY_URL: debe usar https');
    const sameHost = `https://base-mainnet.g.alchemy.com/v2/${randomBytes(16).toString('hex')}`;
    const same = configError(() =>
      loadConfig({ env: productionEnv({ RPC_SECONDARY_URL_FILE: secretFile('rpc2', sameHost) }), envFile: null }),
    );
    expect(same.problems).toContain('RPC_SECONDARY_URL: debe ser de un proveedor distinto del primario');
    const noKey = configError(() =>
      loadConfig({
        env: productionEnv({ RPC_PRIMARY_URL_FILE: secretFile('rpc3', 'https://base-mainnet.example-rpc.io/') }),
        envFile: null,
      }),
    );
    expect(noKey.problems).toContain('RPC_PRIMARY_URL: no incluye la credencial del proveedor');
  });
});

describe('configuraciones de las CLIs', () => {
  it('db:* sólo necesita APP_ENV y DATABASE_MIGRATION_URL', () => {
    const url = `postgres://mtw_migrator:${randomBytes(24).toString('hex')}@127.0.0.1:55432/mtw_wallet`;
    const config = loadMigrationConfig({ env: { APP_ENV: 'local', DATABASE_MIGRATION_URL: url }, envFile: null });
    expect(config.migrationUrl.reveal()).toBe(url);
    expect(JSON.stringify(config)).not.toContain(url);
  });

  it('audit:verify necesita DATABASE_URL y AUDIT_CHAIN_KEY', () => {
    const error = configError(() => loadAuditVerifyConfig({ env: { APP_ENV: 'local' }, envFile: null }));
    expect(error.problems.map((p) => p.split(':')[0]).sort()).toEqual(['AUDIT_CHAIN_KEY', 'DATABASE_URL']);
  });
});
