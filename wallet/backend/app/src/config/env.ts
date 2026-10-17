// Configuración del backend (P08.T02): schema Zod por APP_ENV (local | staging | production).
//
// - Todo secreto acepta `<VAR>` o `<VAR>_FILE` (archivo de secrets de Docker Compose en /run/secrets/…, ADR-030);
//   en staging/production sólo se acepta `<VAR>_FILE`.
// - Valores de ejemplo y secretos de baja entropía se rechazan antes de arrancar.
// - Los errores nombran la variable y la regla incumplida; nunca muestran valores.
// - Con APP_ENV=local (o sin APP_ENV en el entorno) se completa desde wallet/.env; staging/production nunca leen .env.
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { networkLabel } from '../email/format.ts';
import { parseDotenv } from './dotenv.ts';
import { Secret } from './secret.ts';
import {
  connectionUrlProblem,
  isExampleValue,
  isLocalHost,
  parseKey32,
  passwordProblem,
  remoteRpcUrlProblem,
} from './secret-quality.ts';

export const APP_ENVS = ['local', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** wallet/ (las rutas relativas de la configuración local se resuelven desde acá). */
export const WALLET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const MAX_SECRET_FILE_BYTES = 64 * 1024;

/** Secretos con nombre fijo. Los peppers versionados (`PASSWORD_PEPPER_V<n>`) se detectan por patrón. */
export const SECRET_VARS = [
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'REDIS_URL',
  'RPC_PRIMARY_URL',
  'RPC_SECONDARY_URL',
  'AUDIT_CHAIN_KEY',
  'SESSION_SECRET',
  'CSRF_SECRET',
  'APP_FIELD_ENCRYPTION_KEY',
  'OTP_HMAC_KEY',
  'SESSION_ISSUER_PRIVATE_KEY',
  'EMAIL_PROVIDER_API_KEY',
  'OPAQUE_SERVER_SETUP',
] as const;
const PEPPER_VAR = /^PASSWORD_PEPPER_V([1-9][0-9]{0,2})$/;

export class ConfigError extends Error {
  override name = 'ConfigError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`configuración inválida:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

export interface LoadOptions {
  /** Variables de entorno (default: process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Archivo .env para APP_ENV=local (default: MTW_ENV_FILE o wallet/.env; null lo desactiva). */
  envFile?: string | null;
}

interface ResolvedEnv {
  appEnv: AppEnv;
  values: Record<string, string>;
  problems: string[];
}

function isSecretName(name: string): boolean {
  return (SECRET_VARS as readonly string[]).includes(name) || PEPPER_VAR.test(name);
}

/** Une entorno + .env local, valida APP_ENV y resuelve cada secreto desde `<VAR>` o `<VAR>_FILE`. */
function resolveEnv(options: LoadOptions): ResolvedEnv {
  const processEnv = options.env ?? process.env;
  const problems: string[] = [];
  let merged: Record<string, string | undefined> = { ...processEnv };

  const declaredEnv = processEnv.APP_ENV;
  // MTW_ENV_FILE: otro archivo .env (mismo mecanismo que scripts/secrets-local).
  const envFile =
    options.envFile === undefined ? resolve(processEnv.MTW_ENV_FILE ?? resolve(WALLET_ROOT, '.env')) : options.envFile;
  if ((declaredEnv === undefined || declaredEnv === '' || declaredEnv === 'local') && envFile && existsSync(envFile)) {
    const fileValues = parseDotenv(readFileSync(envFile, 'utf8'));
    merged = { ...fileValues, ...Object.fromEntries(Object.entries(processEnv).filter(([, v]) => v !== '')) };
  }

  const appEnvParse = z.enum(APP_ENVS).safeParse(merged.APP_ENV);
  if (!appEnvParse.success) {
    throw new ConfigError(['APP_ENV: debe ser local, staging o production']);
  }
  const appEnv = appEnvParse.data;
  const strict = appEnv !== 'local';

  const values: Record<string, string> = {};
  const secretNames = new Set<string>();
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === '') continue;
    const base = key.endsWith('_FILE') ? key.slice(0, -'_FILE'.length) : key;
    if (isSecretName(base)) secretNames.add(base);
    else values[key] = value;
  }

  for (const name of secretNames) {
    const direct = merged[name];
    const file = merged[`${name}_FILE`];
    const hasDirect = direct !== undefined && direct !== '';
    const hasFile = file !== undefined && file !== '';
    if (hasDirect && hasFile) {
      problems.push(`${name}: definida a la vez como ${name} y ${name}_FILE`);
      continue;
    }
    if (hasDirect) {
      if (strict) {
        problems.push(`${name}: en ${appEnv} los secretos se leen sólo de ${name}_FILE (ADR-030)`);
        continue;
      }
      values[name] = direct;
      continue;
    }
    if (hasFile) {
      if (strict && !isAbsolute(file)) {
        problems.push(`${name}_FILE: en ${appEnv} debe ser una ruta absoluta`);
        continue;
      }
      const path = isAbsolute(file) ? file : resolve(WALLET_ROOT, file);
      try {
        const stats = statSync(path);
        if (!stats.isFile()) throw new Error('no es un archivo');
        if (stats.size > MAX_SECRET_FILE_BYTES) throw new Error('supera 64 KiB');
        const content = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
        if (content === '') throw new Error('está vacío');
        values[name] = content;
      } catch (error) {
        const reason = error instanceof Error && !('code' in error) ? error.message : 'no se puede leer';
        problems.push(`${name}_FILE: el archivo ${reason}`);
      }
    }
  }
  return { appEnv, values, problems };
}

// ---------------------------------------------------------------------------------------------------------------
// Campos

const port = z.coerce.number({ error: 'debe ser un puerto' }).int().min(1).max(65_535);
const positiveInt = (fallback: number, max = 1_000_000) =>
  z.coerce.number({ error: 'debe ser un entero' }).int().min(1).max(max).default(fallback);

const httpUrl = z.string({ error: 'falta' }).refine(
  (v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { error: 'debe ser una URL http(s)' },
);

const origin = z.string({ error: 'falta' }).refine(
  (v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === v;
    } catch {
      return false;
    }
  },
  { error: 'debe ser un origin (esquema://host[:puerto], sin ruta ni barra final)' },
);

const key32 = z.string({ error: 'falta' }).transform((v, ctx) => {
  const parsed = parseKey32(v);
  if ('error' in parsed) {
    ctx.addIssue({ code: 'custom', message: parsed.error });
    return z.NEVER;
  }
  return new Secret(parsed.key);
});

/**
 * OPAQUE_SERVER_SETUP [B-PSES-02]: ServerSetup de @serenity-kit/opaque (128 bytes en base64url, `pnpm opaque:setup`).
 * El servicio OPAQUE además lo deserializa al arrancar (clave pública del servidor).
 */
const opaqueServerSetup = z.string({ error: 'falta (pnpm --dir backend/app opaque:setup)' }).transform((v, ctx) => {
  if (isExampleValue(v) || !/^[A-Za-z0-9_-]+$/.test(v) || Buffer.from(v, 'base64url').length !== 128) {
    ctx.addIssue({
      code: 'custom',
      message: 'debe ser un ServerSetup de OPAQUE (128 bytes en base64url, pnpm opaque:setup)',
    });
    return z.NEVER;
  }
  return new Secret(v);
});

const postgresUrl = z.string({ error: 'falta' }).transform((v, ctx) => {
  const problem = connectionUrlProblem(v, ['postgres:', 'postgresql:']);
  if (problem) {
    ctx.addIssue({ code: 'custom', message: problem });
    return z.NEVER;
  }
  return new Secret(v);
});

const redisUrl = z.string({ error: 'falta' }).transform((v, ctx) => {
  const problem = connectionUrlProblem(v, ['redis:', 'rediss:']);
  if (problem) {
    ctx.addIssue({ code: 'custom', message: problem });
    return z.NEVER;
  }
  return new Secret(v);
});

const rpcUrl = httpUrl.transform((v) => new Secret(v));

// Vector de test 1 de RFC 8032 (clave privada publicada en la especificación): nunca puede ser una clave real. Se
// compara su SHA-256 para no dejar en el código un literal con forma de credencial.
const RFC8032_VECTOR_1_SHA256 = '644d50ab64864c20a12b3c4656d46b4a48f69ef7c47ecdc8415cd28316b22ef5';

const ed25519PrivateKey = z.string({ error: 'falta' }).transform((v, ctx) => {
  try {
    if (isExampleValue(v)) throw new Error('example');
    const key = createPrivateKey({ key: Buffer.from(v, 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('type');
    const raw = key.export({ format: 'jwk' }).d;
    if (raw && createHash('sha256').update(Buffer.from(raw, 'base64url')).digest('hex') === RFC8032_VECTOR_1_SHA256) {
      ctx.addIssue({ code: 'custom', message: 'es la clave de ejemplo de RFC 8032' });
      return z.NEVER;
    }
    return new Secret(key);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'debe ser una clave privada Ed25519 PKCS#8 (DER en base64)' });
    return z.NEVER;
  }
});

const ed25519PublicKey = z.string({ error: 'falta' }).transform((v, ctx) => {
  try {
    const key = createPublicKey({ key: Buffer.from(v, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('type');
    return key;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'debe ser una clave pública Ed25519 SPKI (DER en base64)' });
    return z.NEVER;
  }
});

/** TRUST_PROXY: `false` (default), cantidad de proxies (1–5) o lista de IPs/CIDRs separada por coma. */
const trustProxy = z
  .string()
  .default('false')
  .transform((v, ctx): false | number | string[] => {
    const value = v.trim();
    if (value === 'false') return false;
    if (/^[1-5]$/.test(value)) return Number(value);
    const list = value.split(',').map((s) => s.trim());
    if (list.length > 0 && list.every((s) => /^[0-9a-fA-F.:]+(?:\/\d{1,3})?$/.test(s))) return list;
    ctx.addIssue({ code: 'custom', message: 'debe ser false, un entero de 1 a 5 o una lista de IPs/CIDRs' });
    return z.NEVER;
  });

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const baseFields = {
  APP_ENV: z.enum(APP_ENVS),
  PLATFORM_ID: z
    .string({ error: 'falta' })
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, { error: 'debe ser un identificador [a-z0-9-] de 2 a 63 caracteres' }),
  CHAIN_ID: z.coerce.number({ error: 'debe ser un entero' }).pipe(z.literal(8453, { error: 'debe ser 8453 (Base)' })),
  LOG_LEVEL: z.enum(LOG_LEVELS, { error: 'nivel de log inválido' }).default('info'),
};

const apiFields = {
  API_BIND_HOST: z.string().min(1).default('127.0.0.1'),
  API_WALLET_PORT: port.default(8080),
  API_RECOVERY_PORT: port.default(8081),
  API_PUBLIC_URL_WALLET: httpUrl,
  API_PUBLIC_URL_RECOVERY: httpUrl,
  WALLET_ORIGIN: origin,
  RECOVERY_ORIGIN: origin,
  TRUST_PROXY: trustProxy,
  API_BODY_LIMIT_BYTES: positiveInt(64 * 1024, 1024 * 1024),
  METRICS_BIND_HOST: z.string().min(1).default('127.0.0.1'),
  METRICS_PORT: port.default(9464),
  WORKER_METRICS_PORT: port.default(9465),
  RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number({ error: 'debe ser un entero' }).int().min(1).max(100_000).optional(),
  AUTH_FAILURE_SPIKE_PER_MINUTE: positiveInt(60, 100_000),
};

const databaseFields = {
  DATABASE_URL: postgresUrl,
  DATABASE_POOL_MAX: positiveInt(10, 200),
};

const queueFields = {
  REDIS_URL: redisUrl,
  OUTBOX_POLL_INTERVAL_MS: positiveInt(500, 60_000),
  OUTBOX_BATCH_SIZE: positiveInt(100, 1_000),
};

const rpcFields = {
  RPC_PRIMARY_URL: rpcUrl,
  RPC_SECONDARY_URL: rpcUrl,
  RPC_QUORUM_MODE: z.enum(['local-single', 'dual'], { error: 'debe ser local-single o dual' }),
  RPC_TIMEOUT_MS: positiveInt(5_000, 60_000),
  RPC_HEALTH_INTERVAL_MS: positiveInt(10_000, 300_000),
  RPC_MAX_HEAD_LAG_BLOCKS: positiveInt(10, 10_000),
  RPC_QUORUM_RETRIES: positiveInt(3, 10),
  RPC_QUORUM_BACKOFF_MS: positiveInt(250, 10_000),
  CONFIRMATION_POLICY: z.enum(['depth', 'tags'], { error: 'debe ser depth o tags' }),
  CONFIRMATION_DEPTH: positiveInt(3, 10_000),
  FINALIZATION_DEPTH: positiveInt(10, 100_000),
};

const EMAIL_ADDRESS = /^[^\s@<>]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/i;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,}$/i;

const emailFields = {
  EMAIL_PROVIDER: z.enum(['smtp', 'mailgun'], { error: 'debe ser smtp o mailgun' }),
  EMAIL_FROM: z.string({ error: 'falta' }).regex(EMAIL_ADDRESS, { error: 'debe ser una dirección de email' }),
  EMAIL_PROVIDER_API_KEY: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const problem = passwordProblem(v);
      if (problem) {
        ctx.addIssue({ code: 'custom', message: `la API key ${problem}` });
        return z.NEVER;
      }
      return new Secret(v);
    }),
  EMAIL_PROVIDER_DOMAIN: z.string().regex(DOMAIN, { error: 'debe ser un dominio' }).optional(),
  EMAIL_PROVIDER_BASE_URL: z
    .string()
    .default('https://api.mailgun.net')
    .refine((v) => ['https://api.mailgun.net', 'https://api.eu.mailgun.net'].includes(v), {
      error: 'debe ser https://api.mailgun.net (US) o https://api.eu.mailgun.net (EU)',
    }),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: port.optional(),
  /** Red que muestran los emails sensibles [B-MAIL-02]; default por APP_ENV (staging sobre el fork lo sobreescribe). */
  EMAIL_NETWORK_LABEL: z.string().min(3).max(80).optional(),
};

const secretFields = {
  AUDIT_CHAIN_KEY: key32,
  SESSION_SECRET: key32,
  CSRF_SECRET: key32,
  APP_FIELD_ENCRYPTION_KEY: key32,
  OTP_HMAC_KEY: key32,
  SESSION_ISSUER_PRIVATE_KEY: ed25519PrivateKey,
  SESSION_ISSUER_PUBLIC_KEY: ed25519PublicKey,
  OPAQUE_SERVER_SETUP: opaqueServerSetup,
};

function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join('.') || '(config)';
    const generic: Record<string, string> = {
      invalid_type: 'falta o tiene un tipo inválido',
      invalid_value: 'valor no permitido',
      too_small: 'fuera de rango',
      too_big: 'fuera de rango',
      invalid_format: 'formato inválido',
    };
    const message = issue.code === 'custom' || issue.message.startsWith('debe') ? issue.message : generic[issue.code];
    return `${path}: ${message ?? 'inválida'}`;
  });
}

function parseWith<T extends z.ZodType>(schema: T, resolved: ResolvedEnv): z.output<T> {
  const result = schema.safeParse(resolved.values);
  const problems = [...resolved.problems, ...(result.success ? [] : formatIssues(result.error.issues))];
  if (problems.length > 0 || !result.success) throw new ConfigError(problems);
  return result.data;
}

function collectPeppers(values: Record<string, string>, problems: string[]): Map<number, Secret<Buffer>> {
  const peppers = new Map<number, Secret<Buffer>>();
  for (const [name, value] of Object.entries(values)) {
    const m = PEPPER_VAR.exec(name);
    if (!m?.[1]) continue;
    const parsed = parseKey32(value);
    if ('error' in parsed) problems.push(`${name}: ${parsed.error}`);
    else peppers.set(Number(m[1]), new Secret(parsed.key));
  }
  if (!peppers.has(1)) problems.push('PASSWORD_PEPPER_V1: falta');
  return peppers;
}

// ---------------------------------------------------------------------------------------------------------------
// Configuración completa (API y worker)

const appSchema = z
  .object({
    ...baseFields,
    ...apiFields,
    ...databaseFields,
    ...queueFields,
    ...rpcFields,
    ...emailFields,
    ...secretFields,
  })
  .superRefine((v, ctx) => {
    const strict = v.APP_ENV !== 'local';
    const issue = (path: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (new Set([v.API_WALLET_PORT, v.API_RECOVERY_PORT, v.METRICS_PORT, v.WORKER_METRICS_PORT]).size !== 4) {
      issue('API_RECOVERY_PORT', 'los puertos de Wallet, Recovery y métricas (API y worker) deben ser distintos');
    }
    if (v.WALLET_ORIGIN === v.RECOVERY_ORIGIN) issue('RECOVERY_ORIGIN', 'debe ser distinto de WALLET_ORIGIN');
    {
      const derived = createPublicKey(v.SESSION_ISSUER_PRIVATE_KEY.reveal()).export({ format: 'der', type: 'spki' });
      const declared = v.SESSION_ISSUER_PUBLIC_KEY.export({ format: 'der', type: 'spki' });
      if (!derived.equals(declared)) {
        issue('SESSION_ISSUER_PUBLIC_KEY', 'no corresponde a SESSION_ISSUER_PRIVATE_KEY');
      }
    }
    const keys = [v.AUDIT_CHAIN_KEY, v.SESSION_SECRET, v.CSRF_SECRET, v.APP_FIELD_ENCRYPTION_KEY, v.OTP_HMAC_KEY];
    if (new Set(keys.map((k) => k.reveal().toString('hex'))).size !== keys.length) {
      issue('AUDIT_CHAIN_KEY', 'las claves simétricas deben ser distintas entre sí');
    }
    if (v.EMAIL_PROVIDER === 'mailgun') {
      if (!v.EMAIL_PROVIDER_API_KEY) issue('EMAIL_PROVIDER_API_KEY', 'falta (EMAIL_PROVIDER=mailgun)');
      if (!v.EMAIL_PROVIDER_DOMAIN) issue('EMAIL_PROVIDER_DOMAIN', 'falta (EMAIL_PROVIDER=mailgun)');
      else if (!v.EMAIL_FROM.toLowerCase().endsWith(`@${v.EMAIL_PROVIDER_DOMAIN.toLowerCase()}`)) {
        issue('EMAIL_FROM', 'debe ser del dominio de envío (EMAIL_PROVIDER_DOMAIN)');
      }
    } else {
      if (!v.SMTP_HOST) issue('SMTP_HOST', 'falta (EMAIL_PROVIDER=smtp)');
      if (v.SMTP_PORT === undefined) issue('SMTP_PORT', 'falta (EMAIL_PROVIDER=smtp)');
    }
    if (!strict) return;
    // ADR-016: SMTP (Mailpit) es sólo de local/CI; staging y producción envían por Mailgun con dominio propio.
    if (v.EMAIL_PROVIDER !== 'mailgun') issue('EMAIL_PROVIDER', `en ${v.APP_ENV} debe ser mailgun (ADR-016)`);
    if (v.EMAIL_PROVIDER_DOMAIN?.toLowerCase().endsWith('.mailgun.org')) {
      issue('EMAIL_PROVIDER_DOMAIN', `en ${v.APP_ENV} debe ser un dominio propio verificado, no el sandbox`);
    }
    for (const name of [
      'API_PUBLIC_URL_WALLET',
      'API_PUBLIC_URL_RECOVERY',
      'WALLET_ORIGIN',
      'RECOVERY_ORIGIN',
    ] as const) {
      const url = new URL(v[name]);
      if (url.protocol !== 'https:') issue(name, `en ${v.APP_ENV} debe usar https`);
      if (isLocalHost(url.hostname)) issue(name, `en ${v.APP_ENV} no puede apuntar a un host local`);
    }
    if (v.RPC_QUORUM_MODE !== 'dual') issue('RPC_QUORUM_MODE', `en ${v.APP_ENV} debe ser dual ([B-RPC-02])`);
    if (v.CONFIRMATION_POLICY !== 'tags') issue('CONFIRMATION_POLICY', `en ${v.APP_ENV} debe ser tags (ADR-018)`);
    for (const name of ['RPC_PRIMARY_URL', 'RPC_SECONDARY_URL'] as const) {
      const problem = remoteRpcUrlProblem(v[name].reveal());
      if (problem) issue(name, problem);
    }
    const primaryHost = new URL(v.RPC_PRIMARY_URL.reveal()).hostname;
    const secondaryHost = new URL(v.RPC_SECONDARY_URL.reveal()).hostname;
    if (primaryHost === secondaryHost) issue('RPC_SECONDARY_URL', 'debe ser de un proveedor distinto del primario');
  });

export type EmailConfig = { from: string; networkLabel: string } & (
  | { provider: 'smtp'; smtpHost: string; smtpPort: number }
  | { provider: 'mailgun'; apiKey: Secret<string>; domain: string; baseUrl: string }
);

export interface AppConfig {
  appEnv: AppEnv;
  platformId: string;
  chainId: 8453;
  logLevel: (typeof LOG_LEVELS)[number];
  api: {
    bindHost: string;
    walletPort: number;
    recoveryPort: number;
    publicUrlWallet: string;
    publicUrlRecovery: string;
    walletOrigin: string;
    recoveryOrigin: string;
    trustProxy: false | number | string[];
    bodyLimitBytes: number;
    /** §7.11: "Try it out" en local/staging; producción sólo publica la spec. */
    docsTryItOut: boolean;
    rateLimitGlobalPerMinute: number;
  };
  auth: { failureSpikePerMinute: number };
  metrics: { bindHost: string; port: number; workerPort: number };
  database: { url: Secret<string>; poolMax: number };
  redis: { url: Secret<string> };
  outbox: { pollIntervalMs: number; batchSize: number };
  rpc: {
    primaryUrl: Secret<string>;
    secondaryUrl: Secret<string>;
    quorumMode: 'local-single' | 'dual';
    timeoutMs: number;
    healthIntervalMs: number;
    maxHeadLagBlocks: number;
    quorumRetries: number;
    quorumBackoffMs: number;
  };
  confirmations: { policy: 'depth' | 'tags'; confirmationDepth: number; finalizationDepth: number };
  email: EmailConfig;
  secrets: {
    auditChainKey: Secret<Buffer>;
    sessionSecret: Secret<Buffer>;
    csrfSecret: Secret<Buffer>;
    fieldEncryptionKey: Secret<Buffer>;
    otpHmacKey: Secret<Buffer>;
    passwordPeppers: ReadonlyMap<number, Secret<Buffer>>;
    sessionIssuerPrivateKey: Secret<KeyObject>;
    sessionIssuerPublicKey: KeyObject;
    opaqueServerSetup: Secret<string>;
  };
}

export function loadConfig(options: LoadOptions = {}): AppConfig {
  const resolved = resolveEnv(options);
  const peppers = collectPeppers(resolved.values, resolved.problems);
  const v = parseWith(appSchema, resolved);
  const defaultRate = v.APP_ENV === 'local' ? 1_000 : 300;
  return {
    appEnv: v.APP_ENV,
    platformId: v.PLATFORM_ID,
    chainId: v.CHAIN_ID,
    logLevel: v.LOG_LEVEL,
    api: {
      bindHost: v.API_BIND_HOST,
      walletPort: v.API_WALLET_PORT,
      recoveryPort: v.API_RECOVERY_PORT,
      publicUrlWallet: v.API_PUBLIC_URL_WALLET,
      publicUrlRecovery: v.API_PUBLIC_URL_RECOVERY,
      walletOrigin: v.WALLET_ORIGIN,
      recoveryOrigin: v.RECOVERY_ORIGIN,
      trustProxy: v.TRUST_PROXY,
      bodyLimitBytes: v.API_BODY_LIMIT_BYTES,
      docsTryItOut: v.APP_ENV !== 'production',
      rateLimitGlobalPerMinute: v.RATE_LIMIT_GLOBAL_PER_MINUTE ?? defaultRate,
    },
    auth: { failureSpikePerMinute: v.AUTH_FAILURE_SPIKE_PER_MINUTE },
    metrics: { bindHost: v.METRICS_BIND_HOST, port: v.METRICS_PORT, workerPort: v.WORKER_METRICS_PORT },
    database: { url: v.DATABASE_URL, poolMax: v.DATABASE_POOL_MAX },
    redis: { url: v.REDIS_URL },
    outbox: { pollIntervalMs: v.OUTBOX_POLL_INTERVAL_MS, batchSize: v.OUTBOX_BATCH_SIZE },
    rpc: {
      primaryUrl: v.RPC_PRIMARY_URL,
      secondaryUrl: v.RPC_SECONDARY_URL,
      quorumMode: v.RPC_QUORUM_MODE,
      timeoutMs: v.RPC_TIMEOUT_MS,
      healthIntervalMs: v.RPC_HEALTH_INTERVAL_MS,
      maxHeadLagBlocks: v.RPC_MAX_HEAD_LAG_BLOCKS,
      quorumRetries: v.RPC_QUORUM_RETRIES,
      quorumBackoffMs: v.RPC_QUORUM_BACKOFF_MS,
    },
    email:
      v.EMAIL_PROVIDER === 'mailgun' && v.EMAIL_PROVIDER_API_KEY && v.EMAIL_PROVIDER_DOMAIN
        ? {
            provider: 'mailgun',
            from: v.EMAIL_FROM,
            networkLabel: networkLabel(v.APP_ENV, v.EMAIL_NETWORK_LABEL),
            apiKey: v.EMAIL_PROVIDER_API_KEY,
            domain: v.EMAIL_PROVIDER_DOMAIN,
            baseUrl: v.EMAIL_PROVIDER_BASE_URL,
          }
        : {
            provider: 'smtp',
            from: v.EMAIL_FROM,
            networkLabel: networkLabel(v.APP_ENV, v.EMAIL_NETWORK_LABEL),
            smtpHost: v.SMTP_HOST ?? '',
            smtpPort: v.SMTP_PORT ?? 0,
          },
    confirmations: {
      policy: v.CONFIRMATION_POLICY,
      confirmationDepth: v.CONFIRMATION_DEPTH,
      finalizationDepth: v.FINALIZATION_DEPTH,
    },
    secrets: {
      auditChainKey: v.AUDIT_CHAIN_KEY,
      sessionSecret: v.SESSION_SECRET,
      csrfSecret: v.CSRF_SECRET,
      fieldEncryptionKey: v.APP_FIELD_ENCRYPTION_KEY,
      otpHmacKey: v.OTP_HMAC_KEY,
      passwordPeppers: peppers,
      sessionIssuerPrivateKey: v.SESSION_ISSUER_PRIVATE_KEY,
      sessionIssuerPublicKey: v.SESSION_ISSUER_PUBLIC_KEY,
      opaqueServerSetup: v.OPAQUE_SERVER_SETUP,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Configuraciones mínimas de las CLIs

export interface MigrationConfig {
  appEnv: AppEnv;
  migrationUrl: Secret<string>;
}

/** `db:migrate` / `db:status` / `db:backup` / `db:restore`: rol mtw_migrator (DDL). */
export function loadMigrationConfig(options: LoadOptions = {}): MigrationConfig {
  const resolved = resolveEnv(options);
  const v = parseWith(z.object({ APP_ENV: baseFields.APP_ENV, DATABASE_MIGRATION_URL: postgresUrl }), resolved);
  return { appEnv: v.APP_ENV, migrationUrl: v.DATABASE_MIGRATION_URL };
}

export interface AuditVerifyConfig {
  appEnv: AppEnv;
  databaseUrl: Secret<string>;
  auditChainKey: Secret<Buffer>;
}

/** `audit:verify`: lectura de audit_events (rol mtw_app) y clave de la cadena HMAC. */
export function loadAuditVerifyConfig(options: LoadOptions = {}): AuditVerifyConfig {
  const resolved = resolveEnv(options);
  const v = parseWith(
    z.object({ APP_ENV: baseFields.APP_ENV, DATABASE_URL: postgresUrl, AUDIT_CHAIN_KEY: key32 }),
    resolved,
  );
  return { appEnv: v.APP_ENV, databaseUrl: v.DATABASE_URL, auditChainKey: v.AUDIT_CHAIN_KEY };
}

// ---------------------------------------------------------------------------------------------------------------
// Cliente del signer [B-SIG-01], [B-SIG-09]

export interface SignerShardEndpoint {
  id: string;
  url: string;
  /** Recibe wallets nuevas (la asignación de las existentes está guardada y no cambia). */
  active: boolean;
}

export interface DatabaseOnlyConfig {
  appEnv: AppEnv;
  databaseUrl: Secret<string>;
}

/** CLIs que sólo tocan la DB con el rol de la aplicación (p. ej. `signer:reassign`). */
export function loadDatabaseConfig(options: LoadOptions = {}): DatabaseOnlyConfig {
  const resolved = resolveEnv(options);
  const v = parseWith(z.object({ APP_ENV: baseFields.APP_ENV, DATABASE_URL: postgresUrl }), resolved);
  return { appEnv: v.APP_ENV, databaseUrl: v.DATABASE_URL };
}
