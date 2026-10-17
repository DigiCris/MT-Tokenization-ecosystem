// Configuración de prueba construida con el loader real (loadConfig) a partir de variables generadas: secretos
// aleatorios, base y Valkey de Testcontainers, RPC del fork.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import * as opaque from '@serenity-kit/opaque';
import { loadConfig, type AppConfig } from '../../src/config/env.ts';

await opaque.ready;

/** ServerSetup de OPAQUE nuevo (lo mismo que `pnpm opaque:setup`). */
export function testOpaqueServerSetup(): string {
  return opaque.server.createSetup();
}

export function randomKey32(): string {
  return randomBytes(32).toString('base64');
}

export function testIssuerKeys(): { SESSION_ISSUER_PRIVATE_KEY: string; SESSION_ISSUER_PUBLIC_KEY: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    SESSION_ISSUER_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    SESSION_ISSUER_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/** Variables válidas para APP_ENV=local (cada test sobreescribe lo que necesita). */
export function localEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const dbPassword = randomBytes(24).toString('hex');
  return {
    APP_ENV: 'local',
    PLATFORM_ID: 'mt-test',
    CHAIN_ID: '8453',
    LOG_LEVEL: 'silent',
    API_PUBLIC_URL_WALLET: 'http://localhost:8080',
    API_PUBLIC_URL_RECOVERY: 'http://localhost:8081',
    WALLET_ORIGIN: 'http://localhost:5173',
    RECOVERY_ORIGIN: 'http://localhost:5174',
    DATABASE_URL: `postgres://mtw_app:${dbPassword}@127.0.0.1:55432/mtw_wallet`,
    DATABASE_MIGRATION_URL: `postgres://mtw_migrator:${randomBytes(24).toString('hex')}@127.0.0.1:55432/mtw_wallet`,
    REDIS_URL: `redis://:${randomBytes(24).toString('hex')}@127.0.0.1:56379/0`,
    RPC_PRIMARY_URL: 'http://127.0.0.1:8545',
    RPC_SECONDARY_URL: 'http://127.0.0.1:8545',
    RPC_QUORUM_MODE: 'local-single',
    CONFIRMATION_POLICY: 'depth',
    EMAIL_PROVIDER: 'smtp',
    EMAIL_FROM: 'no-reply@wallet.localhost',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
    AUDIT_CHAIN_KEY: randomKey32(),
    SESSION_SECRET: randomKey32(),
    CSRF_SECRET: randomKey32(),
    APP_FIELD_ENCRYPTION_KEY: randomKey32(),
    OTP_HMAC_KEY: randomKey32(),
    PASSWORD_PEPPER_V1: randomKey32(),
    OPAQUE_SERVER_SETUP: testOpaqueServerSetup(),
    ...testIssuerKeys(),
    ...overrides,
  };
}

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({ env: localEnv(overrides), envFile: null });
}
