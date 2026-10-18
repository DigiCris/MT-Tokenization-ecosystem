// Configuración pública del build de la app Wallet (P16): entorno, API host, RPC del frontend, origin de Recovery,
// cliente OAuth de Google, clave pública de atestación del signer y el commit con su fecha (SOURCE_DATE_EPOCH). Nunca
// lee secretos. Cada valor sale, en este orden, del entorno del proceso, de wallet/.env (sólo en `local`, y sólo estas
// variables públicas) o del default versionado en wallet/.env.example (sólo en `local` y `ci`, que corren sobre
// localhost). Staging y producción exigen cada valor explícito y con https (los inyecta el pipeline de cada app).
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from './env-file.ts';

export const APP = 'wallet';
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WALLET_ROOT = resolve(APP_ROOT, '../..');
export const ENVIRONMENTS = ['local', 'ci', 'staging', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
/** Clave pública Ed25519 como SPKI DER en base64: prefijo fijo de 12 bytes + 32 bytes de clave. */
export const ED25519_SPKI_BASE64 = /^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/;

export interface BuildConfig {
  app: typeof APP;
  environment: Environment;
  /** Base del API de Wallet, p. ej. `http://localhost:8080/api/v1`. */
  apiBaseUrl: string;
  apiOrigin: string;
  /** RPC propio del frontend (lecturas on-chain); en staging/producción, el endpoint con allowlist de dominio. */
  rpcUrl: string;
  rpcOrigin: string;
  /** Origin de la app Recovery (links y QR de enrollment, [F-LNK-01]). */
  recoveryOrigin: string;
  /** Cliente OAuth de Google de esta app ([F-DRV-03]); null hasta que se configure (lo usa P17). */
  googleClientId: string | null;
  googleRedirectUri: string;
  /** Clave pública Ed25519 de atestación del signer ([B-SIG-07]): SPKI DER en base64 (44 bytes). */
  signerAttestationPublicKey: string;
  /** Deployment de los contratos del sistema del entorno ([F-SEC-08]). */
  deploymentFile: string;
  gitCommit: string;
  sourceDateEpoch: number;
  releaseId: string;
}

type Source = Record<string, string | undefined>;

function origin(name: string, value: string, environment: Environment): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} no es una URL válida`);
  }
  const remote = environment === 'staging' || environment === 'production';
  if (remote ? url.protocol !== 'https:' : url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} debe usar ${remote ? 'https' : 'http o https'} en ${environment}`);
  }
  if (url.username || url.password || url.hash) throw new Error(`${name} no puede llevar credenciales ni fragmento`);
  return url.origin;
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: APP_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Commit y fecha del commit; `MTW_GIT_COMMIT` y `SOURCE_DATE_EPOCH` los fijan cuando no hay checkout de git. */
export function gitIdentity(env: Source = process.env): { gitCommit: string; sourceDateEpoch: number } {
  const gitCommit = env.MTW_GIT_COMMIT ?? git(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/.test(gitCommit)) throw new Error('commit de git inválido (se espera el SHA-1 completo)');
  const epoch = env.SOURCE_DATE_EPOCH ?? git(['log', '-1', '--format=%ct', gitCommit]);
  const sourceDateEpoch = Number(epoch);
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0) throw new Error('SOURCE_DATE_EPOCH inválido');
  return { gitCommit, sourceDateEpoch };
}

export function releaseIdOf(environment: Environment, gitCommit: string): string {
  return `${APP}-${environment}-${gitCommit.slice(0, 12)}`;
}

export function loadBuildConfig(env: Source = process.env): BuildConfig {
  const environment = (env.MTW_ENV ?? 'local') as Environment;
  if (!ENVIRONMENTS.includes(environment)) throw new Error(`MTW_ENV desconocido: ${environment}`);
  const local = environment === 'local';
  const onLocalhost = local || environment === 'ci';
  const dotenv = local ? (readEnvFile(resolve(WALLET_ROOT, '.env')) ?? {}) : {};
  const defaults = onLocalhost ? (readEnvFile(resolve(WALLET_ROOT, '.env.example')) ?? {}) : {};
  const read = (name: string, required = true): string | null => {
    const value = env[name] || dotenv[name] || defaults[name] || '';
    if (value === '' && required) {
      throw new Error(
        `falta ${name} para el build de ${APP} (${environment})${local ? ': completalo en wallet/.env' : ''}`,
      );
    }
    return value === '' ? null : value;
  };
  const required = (name: string): string => read(name) ?? '';

  const apiBaseUrl = required('WALLET_API_BASE_URL').replace(/\/+$/, '');
  const rpcUrl = required('WALLET_FRONTEND_RPC_URL');
  const recoveryOrigin = origin('RECOVERY_ORIGIN', required('RECOVERY_ORIGIN'), environment);
  const googleRedirectUri = required('GOOGLE_OAUTH_REDIRECT_URI_WALLET');
  origin('GOOGLE_OAUTH_REDIRECT_URI_WALLET', googleRedirectUri, environment);
  const signerAttestationPublicKey = required('SIGNER_ATTESTATION_PUBLIC_KEY');
  if (!ED25519_SPKI_BASE64.test(signerAttestationPublicKey)) {
    throw new Error('SIGNER_ATTESTATION_PUBLIC_KEY debe ser una clave pública Ed25519 (SPKI DER en base64)');
  }
  const deploymentFile = resolve(
    env.MTW_DEPLOYMENT_FILE ?? resolve(WALLET_ROOT, `contracts/deployments/${environment}.json`),
  );
  const { gitCommit, sourceDateEpoch } = gitIdentity(env);
  return {
    app: APP,
    environment,
    apiBaseUrl,
    apiOrigin: origin('WALLET_API_BASE_URL', apiBaseUrl, environment),
    rpcUrl,
    rpcOrigin: origin('WALLET_FRONTEND_RPC_URL', rpcUrl, environment),
    recoveryOrigin,
    googleClientId: read('GOOGLE_CLIENT_ID_WALLET', false),
    googleRedirectUri,
    signerAttestationPublicKey,
    deploymentFile,
    gitCommit,
    sourceDateEpoch,
    releaseId: releaseIdOf(environment, gitCommit),
  };
}
