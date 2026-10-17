// OPAQUE (RFC 9807, @serenity-kit/opaque) [B-PSES-02]: el desbloqueo de la Wallet prueba la Password U sin que el
// servidor la vea nunca. La entrada OPAQUE del cliente es hex(AuthSecret_U), ya estirado con Argon2id en el navegador
// ([F-KEY-03]); el keyStretching de OPAQUE queda fijo y versionado en cada registro.
//
// - Registro ligado a (wallet, key_version) con el identificador `mtw:<plataforma>:<walletId>:<keyVersion>`; queda
//   PENDING hasta que U se confirma on-chain como owner y pasa a ACTIVE (el anterior ACTIVE de la wallet se retira).
// - Login en dos pasos: el estado del servidor vive en Valkey 60 s y se consume una sola vez (GETDEL). El cliente ata
//   su session key enviando HMAC(clave de sesión OPAQUE, thumbprint(sessionPublicKey) ‖ loginAttemptId): sólo quien
//   completó OPAQUE conoce esa clave.
// - Con una Password U incorrecta el cliente ni siquiera puede terminar el login; el servidor no aprende nada.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import * as opaque from '@serenity-kit/opaque';
import type { Redis } from 'ioredis';
import type { Address } from 'viem';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Secret } from '../config/secret.ts';
import type { Database } from '../db/schema.ts';
import { jwkThumbprint, type P256PublicJwk } from './keys.ts';
import { safeAddressOf } from './sessions.ts';

/** keyStretching de OPAQUE ([B-PSES-02]): la entrada ya viene estirada, idéntico en registro y login. */
export const OPAQUE_KEY_STRETCHING = { 'argon2id-custom': { memory: 16384, iterations: 1, parallelism: 1 } } as const;
/** Lo que se guarda en `opaque_records.key_stretching` (versión del parámetro). */
export const OPAQUE_KEY_STRETCHING_RECORD = { version: 1, ...OPAQUE_KEY_STRETCHING } as const;
export const OPAQUE_LOGIN_TTL_SECONDS = 60;
const REGISTRATION_RECORD_BYTES = 192;
const LOGIN_PREFIX = 'mtw:opaque:login:';

export function opaqueUserIdentifier(platformId: string, walletId: string, keyVersion: number): string {
  return `mtw:${platformId}:${walletId}:${String(keyVersion)}`;
}

/** HMAC de binding de la session key ([B-PSES-02]); vector en contracts/test/vectors/wire/session-binding.json. */
export function sessionKeyBinding(
  opaqueSessionKey: string,
  sessionPublicKey: P256PublicJwk,
  loginAttemptId: string,
): string {
  return createHmac('sha256', Buffer.from(opaqueSessionKey, 'base64url'))
    .update(`${jwkThumbprint(sessionPublicKey)}${loginAttemptId}`, 'utf8')
    .digest('base64url');
}

export class OpaqueProtocolError extends Error {
  override name = 'OpaqueProtocolError';
}

/** Falla de autenticación (estado vencido o ajeno, mensaje final inválido, binding incorrecto): respuesta uniforme. */
export class OpaqueAuthError extends Error {
  override name = 'OpaqueAuthError';
  readonly reason: 'ATTEMPT' | 'FINISH' | 'BINDING';

  constructor(reason: 'ATTEMPT' | 'FINISH' | 'BINDING') {
    super(`login OPAQUE fallido (${reason})`);
    this.reason = reason;
  }
}

export class WalletNotActiveError extends Error {
  override name = 'WalletNotActiveError';
}

interface LoginState {
  serverLoginState: string;
  userId: string;
  accountSessionId: string;
  walletId: string;
  safe: Address | null;
  keyVersion: number;
  sessionPublicKey: P256PublicJwk;
}

export interface OpaqueLoginResult {
  walletId: string;
  safe: Address | null;
  keyVersion: number;
  sessionPublicKey: P256PublicJwk;
}

export class OpaqueService {
  readonly #db: Kysely<Database>;
  readonly #redis: Redis;
  readonly #setup: Secret<string>;
  readonly #platformId: string;

  private constructor(deps: { db: Kysely<Database>; redis: Redis; serverSetup: Secret<string>; platformId: string }) {
    this.#db = deps.db;
    this.#redis = deps.redis;
    this.#setup = deps.serverSetup;
    this.#platformId = deps.platformId;
  }

  /** Espera el WASM de OPAQUE y valida OPAQUE_SERVER_SETUP (falla al arrancar, no en el primer login). */
  static async create(deps: {
    db: Kysely<Database>;
    redis: Redis;
    serverSetup: Secret<string>;
    platformId: string;
  }): Promise<OpaqueService> {
    await opaque.ready;
    try {
      opaque.server.getPublicKey(deps.serverSetup.reveal());
    } catch {
      throw new Error('OPAQUE_SERVER_SETUP no es un ServerSetup válido (regenerar con pnpm opaque:setup)');
    }
    return new OpaqueService(deps);
  }

  /** Clave pública estática del servidor OPAQUE (el cliente puede fijarla). */
  get serverPublicKey(): string {
    return opaque.server.getPublicKey(this.#setup.reveal());
  }

  // --- Registro -------------------------------------------------------------------------------------------------

  /** Paso 1 del registro: respuesta del servidor al pedido del cliente (no guarda nada). */
  registrationResponse(input: { walletId: string; keyVersion: number; registrationRequest: string }): string {
    try {
      return opaque.server.createRegistrationResponse({
        serverSetup: this.#setup.reveal(),
        userIdentifier: opaqueUserIdentifier(this.#platformId, input.walletId, input.keyVersion),
        registrationRequest: input.registrationRequest,
      }).registrationResponse;
    } catch {
      throw new OpaqueProtocolError('registrationRequest inválido');
    }
  }

  /**
   * Paso 2 del registro: guarda el registro PENDING de (wallet, key_version). Un PENDING anterior de la misma clave
   * (reintento del onboarding) se retira; un ACTIVE nunca se reemplaza por esta vía.
   */
  async storeRegistration(
    trx: Transaction<Database>,
    input: { userId: string; walletId: string; keyVersion: number; registrationRecord: string },
  ): Promise<string> {
    if (!/^[A-Za-z0-9_-]+$/.test(input.registrationRecord))
      throw new OpaqueProtocolError('registrationRecord inválido');
    const record = Buffer.from(input.registrationRecord, 'base64url');
    if (record.length !== REGISTRATION_RECORD_BYTES) throw new OpaqueProtocolError('registrationRecord inválido');
    await trx
      .updateTable('opaque_records')
      .set({ status: 'RETIRED' })
      .where('wallet_id', '=', input.walletId)
      .where('key_version', '=', input.keyVersion)
      .where('status', '=', 'PENDING')
      .execute();
    const row = await trx
      .insertInto('opaque_records')
      .values({
        user_id: input.userId,
        wallet_id: input.walletId,
        key_version: input.keyVersion,
        registration_record: record,
        key_stretching: JSON.stringify(OPAQUE_KEY_STRETCHING_RECORD),
        status: 'PENDING',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** U confirmada on-chain: el registro PENDING de esa versión pasa a ACTIVE y el ACTIVE anterior se retira. */
  async activate(trx: Transaction<Database>, input: { walletId: string; keyVersion: number }): Promise<void> {
    const pending = await trx
      .selectFrom('opaque_records')
      .select('id')
      .where('wallet_id', '=', input.walletId)
      .where('key_version', '=', input.keyVersion)
      .where('status', '=', 'PENDING')
      .forUpdate()
      .executeTakeFirst();
    if (!pending)
      throw new Error(`no hay registro OPAQUE PENDING para la wallet ${input.walletId} v${String(input.keyVersion)}`);
    await trx
      .updateTable('opaque_records')
      .set({ status: 'RETIRED' })
      .where('wallet_id', '=', input.walletId)
      .where('status', '=', 'ACTIVE')
      .execute();
    await trx
      .updateTable('opaque_records')
      .set({ status: 'ACTIVE', activated_at: sql`now()` })
      .where('id', '=', pending.id)
      .execute();
  }

  // --- Login ------------------------------------------------------------------------------------------------------

  /** Paso 1 del login: exige la wallet viva del usuario ACTIVE con su registro ACTIVE ([B-PSES-01]). */
  async loginStart(input: {
    userId: string;
    accountSessionId: string;
    startLoginRequest: string;
    sessionPublicKey: P256PublicJwk;
  }): Promise<{ loginAttemptId: string; loginResponse: string; expiresAt: Date }> {
    const record = await this.#db
      .selectFrom('wallets as w')
      .innerJoin('opaque_records as o', (join) => join.onRef('o.wallet_id', '=', 'w.id').on('o.status', '=', 'ACTIVE'))
      .select(['w.id as walletId', 'w.safe_address', 'o.key_version', 'o.registration_record'])
      .where('w.user_id', '=', input.userId)
      .where('w.platform_id', '=', this.#platformId)
      .where('w.status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!record) throw new WalletNotActiveError('la wallet del usuario no está activa');
    let started: { serverLoginState: string; loginResponse: string };
    try {
      started = opaque.server.startLogin({
        serverSetup: this.#setup.reveal(),
        userIdentifier: opaqueUserIdentifier(this.#platformId, record.walletId, record.key_version),
        registrationRecord: record.registration_record.toString('base64url'),
        startLoginRequest: input.startLoginRequest,
      });
    } catch {
      throw new OpaqueProtocolError('startLoginRequest inválido');
    }
    const loginAttemptId = randomUUID();
    const state: LoginState = {
      serverLoginState: started.serverLoginState,
      userId: input.userId,
      accountSessionId: input.accountSessionId,
      walletId: record.walletId,
      safe: safeAddressOf(record.safe_address),
      keyVersion: record.key_version,
      sessionPublicKey: input.sessionPublicKey,
    };
    await this.#redis.set(`${LOGIN_PREFIX}${loginAttemptId}`, JSON.stringify(state), 'EX', OPAQUE_LOGIN_TTL_SECONDS);
    return {
      loginAttemptId,
      loginResponse: started.loginResponse,
      expiresAt: new Date(Date.now() + OPAQUE_LOGIN_TTL_SECONDS * 1000),
    };
  }

  /** Paso 2 del login: consume el estado (un solo uso), verifica el mensaje final y el binding de la session key. */
  async loginFinish(input: {
    userId: string;
    accountSessionId: string;
    loginAttemptId: string;
    finishLoginRequest: string;
    sessionKeyBinding: string;
  }): Promise<OpaqueLoginResult> {
    const raw = await this.#redis.getdel(`${LOGIN_PREFIX}${input.loginAttemptId}`);
    if (raw === null) throw new OpaqueAuthError('ATTEMPT');
    const state = JSON.parse(raw) as LoginState;
    if (state.userId !== input.userId || state.accountSessionId !== input.accountSessionId)
      throw new OpaqueAuthError('ATTEMPT');
    let sessionKey: string;
    try {
      sessionKey = opaque.server.finishLogin({
        serverLoginState: state.serverLoginState,
        finishLoginRequest: input.finishLoginRequest,
      }).sessionKey;
    } catch {
      throw new OpaqueAuthError('FINISH');
    }
    const expected = Buffer.from(
      sessionKeyBinding(sessionKey, state.sessionPublicKey, input.loginAttemptId),
      'base64url',
    );
    const actual = Buffer.from(input.sessionKeyBinding, 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new OpaqueAuthError('BINDING');
    return {
      walletId: state.walletId,
      safe: state.safe,
      keyVersion: state.keyVersion,
      sessionPublicKey: state.sessionPublicKey,
    };
  }
}
