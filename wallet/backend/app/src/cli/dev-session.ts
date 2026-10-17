// `pnpm dev:session` (P10.T07, sólo APP_ENV=local): material de PlatformSession para probar rutas críticas desde
// Swagger "Try it out" sin frontend. No existe un endpoint equivalente: el CLI hace lo mismo que el navegador contra la
// API local (login de cuenta, AuthSecret_U = HKDF(Argon2id(Password U)), OPAQUE start/finish con una session key P-256
// atada) y firma un request con [B-PSES-05].
//
//   pnpm dev:session                       desbloquea (si hace falta) y firma POST /api/v1/platform-sessions/check
//   pnpm dev:session --method POST --path /api/v1/... --body '{"a":1}'
//   pnpm dev:session --print               además muestra los headers en la terminal
//
// La primera vez crea el usuario de desarrollo atado a la Safe del seed local (contracts/deployments/local.json, `pnpm
// seed-local`): cuenta verificada, wallet ACTIVE, metadatos KDF de U y registro OPAQUE ACTIVE. Contraseñas, session key
// y headers quedan en wallet/.secrets/ (0600, fuera de git); por defecto no se imprime ningún valor sensible.
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import * as opaque from '@serenity-kit/opaque';
import { sql } from 'kysely';
import { getAddress, hexToBytes } from 'viem';
import { PasswordHasher } from '../auth/password.ts';
import { parseDotenv } from '../config/dotenv.ts';
import { loadConfig } from '../config/env.ts';
import { createDatabase } from '../db/kysely.ts';
import { withTransaction } from '../db/transaction.ts';
import { DEFAULT_KDF, deriveAuthSecret, opaqueInput, type KdfParams } from '../platform-session/auth-secret.ts';
import type { P256PublicJwk } from '../platform-session/keys.ts';
import {
  OPAQUE_KEY_STRETCHING,
  OPAQUE_KEY_STRETCHING_RECORD,
  opaqueUserIdentifier,
  sessionKeyBinding,
} from '../platform-session/opaque.ts';
import { canonicalRequest } from '../platform-session/request-signature.ts';

const WALLET_ROOT = resolve(import.meta.dirname, '../../../..');
const SECRETS = resolve(WALLET_ROOT, '.secrets');
const STATE_FILE = resolve(SECRETS, 'dev-session.json');
const HEADERS_FILE = resolve(SECRETS, 'dev-session-headers.json');
const SEED_FILE = resolve(WALLET_ROOT, 'contracts/deployments/local.json');

interface State {
  email: string;
  accountPassword: string;
  passwordU: string;
  kdf: KdfParams;
  session?: {
    cookie: string;
    csrfToken: string;
    token: string;
    sessionId: string;
    expiresAt: string;
    privateJwk: P256PublicJwk & { d: string };
  };
}

const codeOf = (json: Record<string, unknown>): string => (typeof json.code === 'string' ? json.code : '');

function fail(message: string): never {
  process.stderr.write(`dev:session: ${message}\n`);
  process.exit(1);
}

// `pnpm dev:session -- --method …` llega con el `--` literal: se descarta.
const argv = process.argv.slice(2);
const { values: args } = parseArgs({
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: {
    method: { type: 'string', default: 'POST' },
    path: { type: 'string', default: '/api/v1/platform-sessions/check' },
    body: { type: 'string', default: '{}' },
    print: { type: 'boolean', default: false },
  },
});

// Antes de cargar la configuración completa: fuera de local no se hace nada (ni siquiera se valida el resto).
const envFile = resolve(process.env.MTW_ENV_FILE ?? resolve(WALLET_ROOT, '.env'));
const declaredEnv =
  process.env.APP_ENV ??
  (existsSync(envFile) ? parseDotenv(readFileSync(envFile, 'utf8')).APP_ENV : undefined) ??
  'local';
if (declaredEnv !== 'local')
  fail(`sólo existe con APP_ENV=local (APP_ENV=${declaredEnv}); no hay un endpoint equivalente`);

const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    fail(error instanceof Error ? error.message : 'configuración inválida');
  }
})();

const API = `http://127.0.0.1:${String(config.api.walletPort)}`;
const ORIGIN = config.api.walletOrigin;

function saveSecret(path: string, value: unknown): void {
  mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function loadState(): State {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
  const state: State = {
    email: `dev-${config.platformId}@wallet.localhost`,
    accountPassword: `Dev-${randomBytes(12).toString('base64url')}`,
    passwordU: `dev password u ${randomBytes(8).toString('hex')}`,
    kdf: {
      memoryKiB: DEFAULT_KDF.memoryKiB,
      iterations: DEFAULT_KDF.iterations,
      parallelism: DEFAULT_KDF.parallelism,
      salt: randomBytes(16).toString('base64url'),
    },
  };
  saveSecret(STATE_FILE, state);
  return state;
}

/** Usuario de desarrollo atado a la Safe del seed local (idempotente). */
async function bootstrap(state: State): Promise<void> {
  if (!existsSync(SEED_FILE))
    fail('falta contracts/deployments/local.json: correr pnpm deploy-local && pnpm seed-local');
  const seed = (JSON.parse(readFileSync(SEED_FILE, 'utf8')) as { seed?: { safe?: string; userKey?: string } }).seed;
  if (!seed?.safe || !seed.userKey) fail('el deployment local no tiene seed: correr pnpm seed-local');
  await opaque.ready;
  const db = createDatabase({
    connectionString: config.database.url.reveal(),
    applicationName: 'dev-session',
    poolMax: 2,
  });
  try {
    const existing = await db
      .selectFrom('users as u')
      .innerJoin('wallets as w', 'w.user_id', 'u.id')
      .innerJoin('opaque_records as o', (j) => j.onRef('o.wallet_id', '=', 'w.id').on('o.status', '=', 'ACTIVE'))
      .select('u.id')
      .where('u.platform_id', '=', config.platformId)
      .where('u.email', '=', state.email)
      .where('w.status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (existing) return;
    const { hash, pepperVersion } = await new PasswordHasher(config.secrets.passwordPeppers).hash(
      state.accountPassword,
    );
    const safeBytes = Buffer.from(hexToBytes(getAddress(seed.safe)));
    const authInput = opaqueInput(deriveAuthSecret(state.passwordU, state.kdf));
    await withTransaction(db, async (trx) => {
      const user = await trx
        .insertInto('users')
        .values({
          platform_id: config.platformId,
          email: state.email,
          password_hash: hash,
          pepper_version: pepperVersion,
          email_verified_at: sql`now()`,
        })
        .onConflict((oc) =>
          oc
            .columns(['platform_id', 'email'])
            .doUpdateSet({ password_hash: hash, pepper_version: pepperVersion, email_verified_at: sql`now()` }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      // Otra wallet viva (de un bootstrap anterior sin registro OPAQUE) queda abandonada.
      await trx
        .updateTable('wallets')
        .set({ status: 'ABANDONED' })
        .where('user_id', '=', user.id)
        .where('status', 'not in', ['FAILED', 'ABANDONED', 'MIGRATED'])
        .execute();
      await trx
        .updateTable('wallets')
        .set({ safe_address: null })
        .where('safe_address', '=', safeBytes)
        .where('status', '=', 'ABANDONED')
        .execute();
      const wallet = await trx
        .insertInto('wallets')
        .values({
          user_id: user.id,
          platform_id: config.platformId,
          chain_id: config.chainId,
          status: 'ACTIVE',
          safe_address: safeBytes,
          activated_at: sql`now()`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('wallet_keys_metadata')
        .set({ status: 'REVOKED', deactivated_at: sql`now()` })
        .where('key_address', '=', Buffer.from(hexToBytes(getAddress(seed.userKey ?? ''))))
        .where('status', 'in', ['PENDING', 'ACTIVE'])
        .execute();
      await trx
        .insertInto('wallet_keys_metadata')
        .values({
          wallet_id: wallet.id,
          role: 'U',
          key_address: Buffer.from(hexToBytes(getAddress(seed.userKey ?? ''))),
          key_version: 1,
          status: 'ACTIVE',
          source: 'INTERNAL',
          kdf_params: JSON.stringify({ ...DEFAULT_KDF, salt: state.kdf.salt }),
          activated_at: sql`now()`,
        })
        .execute();
      const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password: authInput });
      const { registrationResponse } = opaque.server.createRegistrationResponse({
        serverSetup: config.secrets.opaqueServerSetup.reveal(),
        userIdentifier: opaqueUserIdentifier(config.platformId, wallet.id, 1),
        registrationRequest,
      });
      const { registrationRecord } = opaque.client.finishRegistration({
        clientRegistrationState,
        registrationResponse,
        password: authInput,
        keyStretching: OPAQUE_KEY_STRETCHING,
      });
      await trx
        .insertInto('opaque_records')
        .values({
          user_id: user.id,
          wallet_id: wallet.id,
          key_version: 1,
          registration_record: Buffer.from(registrationRecord, 'base64url'),
          key_stretching: JSON.stringify(OPAQUE_KEY_STRETCHING_RECORD),
          status: 'ACTIVE',
          activated_at: sql`now()`,
        })
        .execute();
    });
    process.stdout.write(`usuario de desarrollo listo (${state.email}, Safe ${getAddress(seed.safe)})\n`);
  } finally {
    await db.destroy();
  }
}

/** Mini navegador: cookies, Origin y CSRF contra la API local. */
class Browser {
  readonly #jar = new Map<string, string>();
  csrf: string | null = null;

  get cookie(): string {
    return [...this.#jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    if (method !== 'GET' && this.csrf === null) {
      const csrf = await this.request('GET', '/api/v1/auth/csrf');
      this.csrf = String(csrf.json.csrfToken);
    }
    const headers: Record<string, string> = { origin: ORIGIN };
    if (this.#jar.size > 0) headers.cookie = this.cookie;
    if (method !== 'GET' && this.csrf) headers['x-csrf-token'] = this.csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      fail(`la API local no responde en ${API} (correr pnpm --dir backend/app dev:api)`);
    }
    for (const raw of response.headers.getSetCookie()) {
      const [pair = ''] = raw.split(';');
      const eq = pair.indexOf('=');
      const value = pair.slice(eq + 1);
      if (value === '' || /expires=thu, 01 jan 1970/i.test(raw)) this.#jar.delete(pair.slice(0, eq));
      else this.#jar.set(pair.slice(0, eq), value);
    }
    const text = await response.text();
    const json = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (typeof json.csrfToken === 'string') this.csrf = json.csrfToken;
    return { status: response.status, json };
  }
}

async function unlock(state: State): Promise<NonNullable<State['session']>> {
  await opaque.ready;
  const browser = new Browser();
  const login = await browser.request('POST', '/api/v1/auth/login', {
    email: state.email,
    password: state.accountPassword,
  });
  if (login.status !== 200) fail(`login de cuenta: ${String(login.status)} ${codeOf(login.json)}`);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  const jwk: P256PublicJwk = { kty: 'EC', crv: 'P-256', x: pub.x ?? '', y: pub.y ?? '' };
  const authInput = opaqueInput(deriveAuthSecret(state.passwordU, state.kdf));
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password: authInput });
  const started = await browser.request('POST', '/api/v1/platform-sessions/opaque/start', {
    startLoginRequest,
    sessionPublicKey: jwk,
  });
  if (started.status !== 200) fail(`opaque/start: ${String(started.status)} ${codeOf(started.json)}`);
  const loginAttemptId = String(started.json.loginAttemptId);
  const finished = opaque.client.finishLogin({
    clientLoginState,
    loginResponse: String(started.json.loginResponse),
    password: authInput,
    keyStretching: OPAQUE_KEY_STRETCHING,
  });
  if (!finished)
    fail(
      'la Password U de desarrollo no abre el registro OPAQUE (borrar wallet/.secrets/dev-session.json y reintentar)',
    );
  const done = await browser.request('POST', '/api/v1/platform-sessions/opaque/finish', {
    loginAttemptId,
    finishLoginRequest: finished.finishLoginRequest,
    sessionKeyBinding: sessionKeyBinding(finished.sessionKey, jwk, loginAttemptId),
  });
  if (done.status !== 200) fail(`opaque/finish: ${String(done.status)} ${codeOf(done.json)}`);
  const session = done.json.session as { id: string; expiresAt: string };
  return {
    cookie: browser.cookie,
    csrfToken: browser.csrf ?? '',
    token: String(done.json.token),
    sessionId: session.id,
    expiresAt: session.expiresAt,
    privateJwk: { ...jwk, d: String(privateKey.export({ format: 'jwk' }).d) },
  };
}

const state = loadState();
await bootstrap(state);
if (!state.session || Date.parse(state.session.expiresAt) - Date.now() < 60_000) {
  state.session = await unlock(state);
  saveSecret(STATE_FILE, state);
}
const session = state.session;
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomBytes(16).toString('hex');
const method = args.method.toUpperCase();
const canonical = canonicalRequest({
  method,
  path: args.path,
  body: args.body,
  timestamp,
  nonce,
  sessionId: session.sessionId,
});
const signature = sign('sha256', Buffer.from(canonical, 'utf8'), {
  key: createPrivateKey({ key: session.privateJwk, format: 'jwk' }),
  dsaEncoding: 'ieee-p1363',
}).toString('base64url');
const output = {
  request: { method, path: args.path, body: args.body },
  headers: {
    Cookie: session.cookie,
    'X-CSRF-Token': session.csrfToken,
    'X-Platform-Session': session.token,
    'X-Session-Timestamp': timestamp,
    'X-Session-Nonce': nonce,
    'X-Session-Signature': signature,
  },
  signatureValidUntil: new Date((Number(timestamp) + 60) * 1000).toISOString(),
  platformSessionExpiresAt: session.expiresAt,
};
saveSecret(HEADERS_FILE, output);
process.stdout.write(
  `headers de ${method} ${args.path} en ${HEADERS_FILE} (firma válida 60 s y una sola vez; PlatformSession hasta ${session.expiresAt})\n`,
);
if (args.print) process.stdout.write(`${JSON.stringify(output.headers, null, 2)}\n`);
