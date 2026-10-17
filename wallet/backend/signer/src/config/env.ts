// Configuración del signer-service (un proceso por shard). Igual que el backend pero independiente:
//
// - Todo secreto acepta `<VAR>` o `<VAR>_FILE` (secret de Docker Compose en /run/secrets/…, ADR-030); en
//   staging/production sólo `<VAR>_FILE` con ruta absoluta.
// - Con APP_ENV=local se completa desde wallet/.env; staging/production nunca leen .env.
// - Los errores nombran la variable y la regla; nunca muestran valores.
// - En local, `--shard platform` (cuenta gas tank) toma sus variables propias de `SIGNER_PLATFORM_*` (puerto,
//   keystores, credencial y DB distintos de los del shard dev-1).
import { createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ed25519PrivateKey, ed25519PublicKey } from '../crypto/jws.ts';
import { parseDotenv } from './dotenv.ts';
import { Secret } from './secret.ts';

export const WALLET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export const SECRET_VARS = [
  'SIGNER_DATABASE_URL',
  'SIGNER_ATTESTATION_PRIVATE_KEY',
  'SIGNER_RPC_PRIMARY_URL',
  'SIGNER_RPC_SECONDARY_URL',
] as const;

/** Variables propias de cada shard que en local el shard `platform` toma de `SIGNER_PLATFORM_*`. */
const PER_SHARD = ['PORT', 'KEYSTORE_DIR', 'UNLOCK_CREDENTIAL_FILE', 'DATABASE_URL'] as const;

export class ConfigError extends Error {
  override name = 'ConfigError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`configuración del signer inválida:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

export interface SignerConfig {
  appEnv: 'local' | 'staging' | 'production';
  provider: 'development' | 'selfhosted';
  shardId: string;
  /** El shard `platform` firma sólo para la cuenta gas tank [B-SIG-05]. */
  platform: boolean;
  host: string;
  port: number;
  keystoreDir: string;
  credentialFile: string;
  databaseUrl: Secret<string>;
  attestationPrivateKey: Secret<KeyObject>;
  attestationPublicKey: KeyObject;
  rpc: {
    primaryUrl: Secret<string>;
    secondaryUrl: Secret<string>;
    mode: 'local-single' | 'dual';
    timeoutMs: number;
    retries: number;
    backoffMs: number;
  };
  mtls: { caPath: string; certPath: string; keyPath: string; allowedClientNames: string[] };
  policy: { snapshotPath: string; publicKey: KeyObject };
  sessionIssuerKeys: KeyObject[];
  integrity: { required: boolean; monitorKeys: KeyObject[] };
  logLevel: string;
}

export interface LoadOptions {
  env?: Readonly<Record<string, string | undefined>>;
  envFile?: string | null;
  /** `--shard <id>`: en local, `platform` usa `SIGNER_PLATFORM_*`. */
  shard?: string;
}

const MAX_SECRET_FILE_BYTES = 64 * 1024;

function readSecretFile(path: string): string {
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > MAX_SECRET_FILE_BYTES) throw new Error('archivo inválido');
  const content = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  if (content === '') throw new Error('vacío');
  return content;
}

export function loadConfig(options: LoadOptions = {}): SignerConfig {
  const processEnv = options.env ?? process.env;
  let merged: Record<string, string | undefined> = { ...processEnv };
  const declared = processEnv.APP_ENV;
  const envFile =
    options.envFile === undefined ? resolve(processEnv.MTW_ENV_FILE ?? resolve(WALLET_ROOT, '.env')) : options.envFile;
  if ((declared === undefined || declared === '' || declared === 'local') && envFile && existsSync(envFile)) {
    merged = {
      ...parseDotenv(readFileSync(envFile, 'utf8')),
      ...Object.fromEntries(Object.entries(processEnv).filter(([, v]) => v !== '')),
    };
  }
  const problems: string[] = [];
  const appEnvParse = z.enum(['local', 'staging', 'production']).safeParse(merged.APP_ENV);
  if (!appEnvParse.success) throw new ConfigError(['APP_ENV: debe ser local, staging o production']);
  const appEnv = appEnvParse.data;
  const strict = appEnv !== 'local';

  // Shard elegido por línea de comandos.
  const shard = options.shard ?? merged.SIGNER_SHARD_ID;
  if (options.shard !== undefined && options.shard !== merged.SIGNER_SHARD_ID) {
    if (strict) problems.push(`--shard ${options.shard}: en ${appEnv} cada contenedor tiene su SIGNER_SHARD_ID`);
    else if (options.shard === 'platform') {
      for (const name of PER_SHARD) {
        const value = merged[`SIGNER_PLATFORM_${name}`];
        merged[`SIGNER_${name}`] = value;
        if (value === undefined || value === '')
          problems.push(`SIGNER_PLATFORM_${name}: requerida para --shard platform`);
      }
    } else problems.push(`--shard ${options.shard}: en local sólo SIGNER_SHARD_ID o platform`);
    merged.SIGNER_SHARD_ID = options.shard;
  }

  const value = (name: string): string | undefined => {
    const v = merged[name];
    return v === undefined || v === '' ? undefined : v;
  };
  const secret = (name: (typeof SECRET_VARS)[number]): string | undefined => {
    const direct = value(name);
    const file = value(`${name}_FILE`);
    if (direct !== undefined && file !== undefined) {
      problems.push(`${name}: definida a la vez como ${name} y ${name}_FILE`);
      return undefined;
    }
    if (direct !== undefined) {
      if (strict) {
        problems.push(`${name}: en ${appEnv} los secretos se leen sólo de ${name}_FILE (ADR-030)`);
        return undefined;
      }
      return direct;
    }
    if (file !== undefined) {
      if (strict && !isAbsolute(file)) {
        problems.push(`${name}_FILE: en ${appEnv} debe ser una ruta absoluta`);
        return undefined;
      }
      try {
        return readSecretFile(isAbsolute(file) ? file : resolve(WALLET_ROOT, file));
      } catch {
        problems.push(`${name}_FILE: no se puede leer`);
        return undefined;
      }
    }
    problems.push(`${name}: requerida`);
    return undefined;
  };
  const path = (name: string): string => {
    const v = value(name);
    if (v === undefined) {
      problems.push(`${name}: requerida`);
      return '';
    }
    if (strict && !isAbsolute(v)) problems.push(`${name}: en ${appEnv} debe ser una ruta absoluta`);
    return isAbsolute(v) ? v : resolve(WALLET_ROOT, v);
  };
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const v = value(name);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name}: entero entre ${min} y ${max}`);
      return fallback;
    }
    return n;
  };
  const edPublic = (name: string, required = true): KeyObject[] => {
    const v = value(name);
    if (v === undefined) {
      if (required) problems.push(`${name}: requerida`);
      return [];
    }
    try {
      // Varias claves separadas por coma: ventana dual durante una rotación del emisor.
      return v.split(',').map((k) => ed25519PublicKey(k.trim()));
    } catch {
      problems.push(`${name}: clave pública Ed25519 (SPKI DER en base64) inválida`);
      return [];
    }
  };

  const provider = z.enum(['development', 'selfhosted']).safeParse(value('SIGNER_PROVIDER'));
  if (!provider.success) problems.push('SIGNER_PROVIDER: development o selfhosted');
  else if (provider.data === 'development' && appEnv !== 'local') {
    problems.push(`SIGNER_PROVIDER: development sólo con APP_ENV=local (es ${appEnv})`);
  }
  const shardId = shard ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(shardId)) problems.push('SIGNER_SHARD_ID: [a-z0-9-], hasta 63 caracteres');
  const mode = z
    .enum(['local-single', 'dual'])
    .safeParse(value('SIGNER_RPC_QUORUM_MODE') ?? (strict ? 'dual' : 'local-single'));
  if (!mode.success) problems.push('SIGNER_RPC_QUORUM_MODE: local-single o dual');
  else if (strict && mode.data !== 'dual')
    problems.push(`SIGNER_RPC_QUORUM_MODE: en ${appEnv} debe ser dual ([B-RPC-02])`);

  const databaseUrl = secret('SIGNER_DATABASE_URL');
  const attestation = secret('SIGNER_ATTESTATION_PRIVATE_KEY');
  const primary = secret('SIGNER_RPC_PRIMARY_URL');
  const secondary = secret('SIGNER_RPC_SECONDARY_URL');
  let attestationPrivateKey: KeyObject | undefined;
  if (attestation !== undefined) {
    try {
      attestationPrivateKey = ed25519PrivateKey(attestation);
    } catch {
      problems.push('SIGNER_ATTESTATION_PRIVATE_KEY: clave privada Ed25519 (PKCS#8 DER en base64) inválida');
    }
  }
  const [policyKey] = edPublic('POLICY_SIGNING_PUBLIC_KEY');
  const sessionIssuerKeys = edPublic('SESSION_ISSUER_PUBLIC_KEY');
  const integrityRequired = (value('INTEGRITY_REQUIRED') ?? (strict ? 'true' : 'false')) === 'true';
  if (strict && !integrityRequired) problems.push(`INTEGRITY_REQUIRED: en ${appEnv} debe ser true (fail-closed)`);
  const monitorKeys = edPublic('INTEGRITY_MONITOR_PUBLIC_KEY', integrityRequired);

  const config = {
    appEnv,
    provider: provider.success ? provider.data : 'selfhosted',
    shardId,
    platform: shardId === 'platform',
    host: value('SIGNER_HOST') ?? (strict ? '0.0.0.0' : '127.0.0.1'),
    port: int('SIGNER_PORT', 8090, 1, 65_535),
    keystoreDir: path('SIGNER_KEYSTORE_DIR'),
    credentialFile: path('SIGNER_UNLOCK_CREDENTIAL_FILE'),
    rpcTimeout: int('RPC_TIMEOUT_MS', 5_000, 100, 60_000),
    mtls: {
      caPath: path('MTLS_CA_CERT_PATH'),
      certPath: path('MTLS_SIGNER_SERVER_CERT_PATH'),
      keyPath: path('MTLS_SIGNER_SERVER_KEY_PATH'),
      allowedClientNames: (value('MTLS_ALLOWED_CLIENT_NAMES') ?? 'mtw-backend').split(',').map((s) => s.trim()),
    },
    policyPath: path('POLICY_SNAPSHOT_PATH'),
  };
  if (
    problems.length > 0 ||
    databaseUrl === undefined ||
    attestationPrivateKey === undefined ||
    primary === undefined ||
    secondary === undefined ||
    policyKey === undefined
  ) {
    throw new ConfigError(problems.length > 0 ? problems : ['configuración incompleta']);
  }
  return {
    appEnv,
    provider: config.provider,
    shardId,
    platform: config.platform,
    host: config.host,
    port: config.port,
    keystoreDir: config.keystoreDir,
    credentialFile: config.credentialFile,
    databaseUrl: new Secret(databaseUrl),
    attestationPrivateKey: new Secret(attestationPrivateKey),
    attestationPublicKey: createPublicKey(attestationPrivateKey),
    rpc: {
      primaryUrl: new Secret(primary),
      secondaryUrl: new Secret(secondary),
      mode: mode.success ? mode.data : 'dual',
      timeoutMs: config.rpcTimeout,
      retries: int('RPC_QUORUM_RETRIES', 3, 0, 10),
      backoffMs: int('RPC_QUORUM_BACKOFF_MS', 250, 0, 10_000),
    },
    mtls: config.mtls,
    policy: { snapshotPath: config.policyPath, publicKey: policyKey },
    sessionIssuerKeys,
    integrity: { required: integrityRequired, monitorKeys },
    logLevel: value('LOG_LEVEL') ?? 'info',
  };
}

export interface ShardConfig {
  appEnv: 'local' | 'staging' | 'production';
  provider: 'development' | 'selfhosted';
  shardId: string;
  keystoreDir: string;
  credentialFile: string;
  databaseUrl: Secret<string>;
}

/**
 * Configuración mínima de los procedimientos offline del ciclo de vida (create-shard, backup, restore, rotación de
 * credencial, migración, custodia): sólo DB, keystores y credencial del shard; mismas reglas de secretos y rutas.
 * `prefix` lee otro juego de variables (p. ej. `TARGET_` para el shard destino de una migración).
 */
export function loadShardConfig(options: LoadOptions & { prefix?: string } = {}): ShardConfig {
  const processEnv = options.env ?? process.env;
  let merged: Record<string, string | undefined> = { ...processEnv };
  const declared = processEnv.APP_ENV;
  const envFile =
    options.envFile === undefined ? resolve(processEnv.MTW_ENV_FILE ?? resolve(WALLET_ROOT, '.env')) : options.envFile;
  if ((declared === undefined || declared === '' || declared === 'local') && envFile && existsSync(envFile)) {
    merged = {
      ...parseDotenv(readFileSync(envFile, 'utf8')),
      ...Object.fromEntries(Object.entries(processEnv).filter(([, v]) => v !== '')),
    };
  }
  const problems: string[] = [];
  const appEnv = z.enum(['local', 'staging', 'production']).safeParse(merged.APP_ENV);
  if (!appEnv.success) throw new ConfigError(['APP_ENV: debe ser local, staging o production']);
  const strict = appEnv.data !== 'local';
  const prefix = options.prefix ?? '';
  if (options.shard === 'platform' && prefix === '' && !strict) {
    for (const name of PER_SHARD) merged[`SIGNER_${name}`] = merged[`SIGNER_PLATFORM_${name}`];
  }
  const get = (name: string): string | undefined => {
    const v = merged[`${prefix}${name}`];
    return v === undefined || v === '' ? undefined : v;
  };
  const path = (name: string): string => {
    const v = get(name);
    if (v === undefined) {
      problems.push(`${prefix}${name}: requerida`);
      return '';
    }
    if (strict && !isAbsolute(v)) problems.push(`${prefix}${name}: en ${appEnv.data} debe ser una ruta absoluta`);
    return isAbsolute(v) ? v : resolve(WALLET_ROOT, v);
  };
  let databaseUrl = get('SIGNER_DATABASE_URL');
  const file = get('SIGNER_DATABASE_URL_FILE');
  if (databaseUrl !== undefined && strict) {
    problems.push(`${prefix}SIGNER_DATABASE_URL: en ${appEnv.data} se lee sólo de ${prefix}SIGNER_DATABASE_URL_FILE`);
    databaseUrl = undefined;
  }
  if (databaseUrl === undefined && file !== undefined) {
    try {
      databaseUrl = readSecretFile(isAbsolute(file) ? file : resolve(WALLET_ROOT, file));
    } catch {
      problems.push(`${prefix}SIGNER_DATABASE_URL_FILE: no se puede leer`);
    }
  }
  if (databaseUrl === undefined && file === undefined) problems.push(`${prefix}SIGNER_DATABASE_URL: requerida`);
  const shardId = options.shard ?? get('SIGNER_SHARD_ID') ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(shardId))
    problems.push(`${prefix}SIGNER_SHARD_ID: [a-z0-9-], hasta 63 caracteres`);
  const provider = get('SIGNER_PROVIDER') ?? (strict ? 'selfhosted' : 'development');
  if (provider !== 'development' && provider !== 'selfhosted')
    problems.push(`${prefix}SIGNER_PROVIDER: development o selfhosted`);
  const keystoreDir = path('SIGNER_KEYSTORE_DIR');
  const credentialFile = path('SIGNER_UNLOCK_CREDENTIAL_FILE');
  if (problems.length > 0 || databaseUrl === undefined) throw new ConfigError(problems);
  return {
    appEnv: appEnv.data,
    provider: provider as ShardConfig['provider'],
    shardId,
    keystoreDir,
    credentialFile,
    databaseUrl: new Secret(databaseUrl),
  };
}
