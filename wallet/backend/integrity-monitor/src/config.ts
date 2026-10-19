// Configuración del integrity monitor por variables de entorno (P20.T02). Toda clave acepta `<VAR>_FILE` (secrets de
// Docker Compose en /run/secrets, ADR-030). Nada se imprime. En staging y producción las apps tienen que ser https y las
// claves públicas de release son las fijadas en el repositorio (config/release-keys/<entorno>/, copiadas a la imagen).
//
//   APP_ENV                          local | staging | production (entorno de la atestación; el APP_ENV del signer)
//   PLATFORM_ID                      id de la plataforma
//   MONITOR_TARGETS                  WALLET=<origin>,RECOVERY=<origin>
//   MONITOR_MANIFEST_ENVIRONMENT     entorno declarado por los manifests (por defecto, APP_ENV)
//   WALLET_RELEASE_PUBLIC_KEY        pública(s) de release de Wallet: SPKI DER base64 separadas por comas, o _FILE con uno
//                                    o más bloques PEM (más de una sólo durante el solapamiento de una rotación)
//   RECOVERY_RELEASE_PUBLIC_KEY      pública(s) de release de Recovery (ídem)
//   MONITOR_ATTESTATION_PRIVATE_KEY  clave de atestación propia (PKCS#8 DER base64) o _FILE
//   MONITOR_OPERATOR_KEYS            {"<operatorId>": "<SPKI DER base64>", …} (JSON) o _FILE: aprobaciones de reanudación
//   MONITOR_STATE_FILE               archivo de estado persistente (pausa y aprobaciones)
//   MONITOR_INTERVAL_SECONDS (60), MONITOR_ATTESTATION_TTL_SECONDS (300), MONITOR_FETCH_TIMEOUT_MS (10000)
//   MONITOR_HOST (127.0.0.1), MONITOR_PORT (8092; el 8090 es del shard del signer)
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AttestationEnvironment } from './attestation.ts';
import { APPS, type App, type Target } from './check.ts';

export interface MonitorConfig {
  appEnv: AttestationEnvironment;
  platformId: string;
  manifestEnvironment: string;
  targets: Target[];
  releaseKeys: Record<App, KeyObject[]>;
  attestationKey: KeyObject;
  operatorKeys: Map<string, KeyObject>;
  stateFile: string;
  intervalSeconds: number;
  attestationTtlSeconds: number;
  fetchTimeoutMs: number;
  host: string;
  port: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  const value = env[name]?.trim();
  return value === '' ? undefined : value;
}

function required(env: Env, name: string): string {
  const value = read(env, name);
  if (value === undefined) throw new ConfigError(`falta ${name} (o ${name}_FILE)`);
  return value;
}

function ed25519(key: KeyObject, name: string): KeyObject {
  if (key.asymmetricKeyType !== 'ed25519') throw new ConfigError(`${name} debe ser una clave Ed25519`);
  return key;
}

export function publicKeyFrom(text: string, name: string): KeyObject {
  try {
    const key = text.includes('-----BEGIN')
      ? createPublicKey(text)
      : createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' });
    return ed25519(key, name);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${name} no es una clave pública válida`);
  }
}

/** Una o más públicas: bloques PEM o DER base64 separados por comas. */
export function publicKeysFrom(text: string, name: string): KeyObject[] {
  const parts = text.includes('-----BEGIN')
    ? (text.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g) ?? [])
    : text
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
  if (parts.length === 0) throw new ConfigError(`${name} no tiene ninguna clave pública`);
  return parts.map((part) => publicKeyFrom(part, name));
}

export function privateKeyFrom(text: string, name: string): KeyObject {
  try {
    const key = text.includes('-----BEGIN')
      ? createPrivateKey(text)
      : createPrivateKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'pkcs8' });
    return ed25519(key, name);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${name} no es una clave privada válida`);
  }
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new ConfigError(`${name} fuera de rango`);
  return value;
}

export function parseTargets(text: string, appEnv: AttestationEnvironment): Target[] {
  const targets = text.split(',').map((entry) => {
    const [app, url] = entry.split('=', 2).map((part) => part.trim());
    if (app !== 'WALLET' && app !== 'RECOVERY') throw new ConfigError(`MONITOR_TARGETS: app desconocida ${app ?? ''}`);
    let parsed: URL;
    try {
      parsed = new URL(url ?? '');
    } catch {
      throw new ConfigError(`MONITOR_TARGETS: URL inválida para ${app}`);
    }
    if (appEnv !== 'local' && parsed.protocol !== 'https:') throw new ConfigError(`MONITOR_TARGETS: ${app} sin https`);
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      throw new ConfigError(`MONITOR_TARGETS: ${app} tiene que ser un origin`);
    }
    return { app, url: parsed.origin } satisfies Target;
  });
  if (new Set(targets.map((t) => t.app)).size !== targets.length) throw new ConfigError('MONITOR_TARGETS repite apps');
  if (targets.length === 0) throw new ConfigError('MONITOR_TARGETS vacío');
  return targets;
}

export function loadConfig(env: Env = process.env): MonitorConfig {
  const appEnv = env.APP_ENV;
  if (appEnv !== 'local' && appEnv !== 'staging' && appEnv !== 'production') {
    throw new ConfigError('APP_ENV tiene que ser local, staging o production');
  }
  const operatorText = read(env, 'MONITOR_OPERATOR_KEYS') ?? '{}';
  let operators: unknown;
  try {
    operators = JSON.parse(operatorText);
  } catch {
    throw new ConfigError('MONITOR_OPERATOR_KEYS no es JSON');
  }
  if (typeof operators !== 'object' || operators === null || Array.isArray(operators)) {
    throw new ConfigError('MONITOR_OPERATOR_KEYS tiene que ser un objeto {operatorId: clave}');
  }
  const operatorKeys = new Map(
    Object.entries(operators as Record<string, unknown>).map(([id, key]) => {
      if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(id) || typeof key !== 'string') {
        throw new ConfigError(`MONITOR_OPERATOR_KEYS: entrada inválida ${id}`);
      }
      return [id, publicKeyFrom(key, `MONITOR_OPERATOR_KEYS.${id}`)] as const;
    }),
  );
  if (appEnv !== 'local' && operatorKeys.size < 2) {
    throw new ConfigError(
      'MONITOR_OPERATOR_KEYS: hacen falta al menos dos operadores (reanudación con doble aprobación)',
    );
  }
  const releaseKeys = Object.fromEntries(
    APPS.map((app) => [app, publicKeysFrom(required(env, `${app}_RELEASE_PUBLIC_KEY`), `${app}_RELEASE_PUBLIC_KEY`)]),
  ) as Record<App, KeyObject[]>;
  const der = (key: KeyObject) => key.export({ format: 'der', type: 'spki' }).toString('base64');
  const walletKeys = new Set(releaseKeys.WALLET.map(der));
  if (releaseKeys.RECOVERY.some((key) => walletKeys.has(der(key)))) {
    throw new ConfigError('las claves de release de Wallet y Recovery tienen que ser distintas (P20.T01)');
  }
  return {
    appEnv,
    platformId: required(env, 'PLATFORM_ID'),
    manifestEnvironment: env.MONITOR_MANIFEST_ENVIRONMENT || appEnv,
    targets: parseTargets(required(env, 'MONITOR_TARGETS'), appEnv),
    releaseKeys,
    attestationKey: privateKeyFrom(required(env, 'MONITOR_ATTESTATION_PRIVATE_KEY'), 'MONITOR_ATTESTATION_PRIVATE_KEY'),
    operatorKeys,
    stateFile: required(env, 'MONITOR_STATE_FILE'),
    intervalSeconds: int(env, 'MONITOR_INTERVAL_SECONDS', 60, 5, 3_600),
    attestationTtlSeconds: int(env, 'MONITOR_ATTESTATION_TTL_SECONDS', 300, 60, 3_600),
    fetchTimeoutMs: int(env, 'MONITOR_FETCH_TIMEOUT_MS', 10_000, 500, 120_000),
    host: env.MONITOR_HOST || '127.0.0.1',
    port: int(env, 'MONITOR_PORT', 8092, 1, 65_535),
  };
}
