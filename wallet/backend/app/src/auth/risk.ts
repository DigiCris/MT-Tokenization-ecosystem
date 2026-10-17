// Fuerza bruta y señales de riesgo [B-AUTH-08], en Valkey (compartido por todas las réplicas de la API).
//
// - Fallos de login por cuenta (email normalizado, exista o no la cuenta: el comportamiento observable es el mismo y no
//   permite enumerar usuarios) y por IP (IPv4 completa, IPv6 /64), en una ventana de 15 minutos. Desde el 5.º fallo de
//   cualquiera de los dos contadores se exige una espera exponencial (1 s, 2 s, 4 s… hasta 15 min); desde el 10.º fallo
//   de la cuenta, bloqueo blando (lo aplica el login, sólo para cuentas que existen; se desbloquea con un OTP por email).
// - Un login correcto limpia el contador de la cuenta, no el de la IP: con una cuenta propia válida no se "resetea" la
//   IP entre intentos de credential stuffing.
// - Señales de credential stuffing: pico de fallos de la plataforma en un minuto (AUTH_FAILURE_SPIKE_PER_MINUTE) y una
//   IP que falla contra muchas cuentas distintas en la ventana. Cada señal se informa una sola vez por ventana; el login
//   la registra en la métrica `mtw_auth_risk_signals_total`, el log y la auditoría (las alertas son de P24).
// - Las claves guardan hashes: ni emails ni IPs en claro en Valkey.
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

export const THROTTLE = {
  windowSeconds: 15 * 60,
  freeFailures: 5,
  softLockFailures: 10,
  maxWaitSeconds: 15 * 60,
  /** Cuentas distintas con fallos desde una misma IP en la ventana que disparan la señal IP_MANY_ACCOUNTS. */
  distinctAccountsPerIp: 10,
} as const;

export type RiskSignal = 'FAILURE_SPIKE' | 'IP_MANY_ACCOUNTS';

export interface FailureOutcome {
  accountFailures: number;
  ipFailures: number;
  /** Espera impuesta antes del próximo intento (la mayor de cuenta e IP). */
  waitSeconds: number;
  /** Señales nuevas (cada una se informa una vez por ventana). */
  signals: RiskSignal[];
}

const PREFIX = 'mtw:auth:';

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 40);
}

function waitFor(failures: number): number {
  if (failures < THROTTLE.freeFailures) return 0;
  return Math.min(2 ** (failures - THROTTLE.freeFailures), THROTTLE.maxWaitSeconds);
}

export class LoginRisk {
  readonly #redis: Redis;
  readonly #spikePerMinute: number;

  constructor(redis: Redis, options: { failureSpikePerMinute: number }) {
    this.#redis = redis;
    this.#spikePerMinute = options.failureSpikePerMinute;
  }

  #account(platformId: string, email: string): string {
    return `acct:${digest(platformId, email)}`;
  }

  #ip(platformId: string, ipKey: string): string {
    return `ip:${digest(platformId, ipKey)}`;
  }

  /** Segundos que faltan para poder intentar de nuevo desde esa IP contra esa cuenta (0 si no hay espera). */
  async retryAfter(platformId: string, email: string, ipKey: string | null): Promise<number> {
    const keys = [`${PREFIX}wait:${this.#account(platformId, email)}`];
    if (ipKey !== null) keys.push(`${PREFIX}wait:${this.#ip(platformId, ipKey)}`);
    const ttls = await Promise.all(keys.map((key) => this.#redis.pttl(key)));
    const ms = Math.max(0, ...ttls);
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  }

  /** Registra un fallo de login: contadores, esperas y señales de credential stuffing. */
  async recordFailure(platformId: string, email: string, ipKey: string | null): Promise<FailureOutcome> {
    const account = this.#account(platformId, email);
    const ip = ipKey === null ? null : this.#ip(platformId, ipKey);
    const minute = Math.floor(Date.now() / 60_000);
    const spikeKey = `${PREFIX}spike:${digest(platformId)}:${String(minute)}`;
    const window = THROTTLE.windowSeconds;

    const multi = this.#redis
      .multi()
      .incr(`${PREFIX}fail:${account}`)
      .expire(`${PREFIX}fail:${account}`, window)
      .incr(spikeKey)
      .expire(spikeKey, 120);
    if (ip !== null) {
      multi
        .incr(`${PREFIX}fail:${ip}`)
        .expire(`${PREFIX}fail:${ip}`, window)
        .pfadd(`${PREFIX}accounts:${ip}`, account)
        .expire(`${PREFIX}accounts:${ip}`, window)
        .pfcount(`${PREFIX}accounts:${ip}`);
    }
    const results = await multi.exec();
    if (!results) throw new Error('Valkey no ejecutó la transacción del contador de fallos');
    const value = (index: number) => {
      const [error, result] = results[index] ?? [null, 0];
      if (error) throw error;
      return Number(result);
    };
    const accountFailures = value(0);
    const platformFailures = value(2);
    const ipFailures = ip === null ? 0 : value(4);
    const distinctAccounts = ip === null ? 0 : value(8);

    const accountWait = waitFor(accountFailures);
    const ipWait = waitFor(ipFailures);
    if (accountWait > 0) await this.#redis.set(`${PREFIX}wait:${account}`, '1', 'EX', accountWait);
    if (ip !== null && ipWait > 0) await this.#redis.set(`${PREFIX}wait:${ip}`, '1', 'EX', ipWait);

    const signals: RiskSignal[] = [];
    if (
      platformFailures >= this.#spikePerMinute &&
      (await this.#once(`spike:${digest(platformId)}:${String(minute)}`, 120))
    ) {
      signals.push('FAILURE_SPIKE');
    }
    if (
      ip !== null &&
      distinctAccounts >= THROTTLE.distinctAccountsPerIp &&
      (await this.#once(`accounts:${ip}`, window))
    ) {
      signals.push('IP_MANY_ACCOUNTS');
    }
    return { accountFailures, ipFailures, waitSeconds: Math.max(accountWait, ipWait), signals };
  }

  /** true sólo la primera vez en la ventana (la señal no se repite en cada fallo). */
  async #once(signal: string, ttlSeconds: number): Promise<boolean> {
    return (await this.#redis.set(`${PREFIX}signal:${signal}`, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  /** Login correcto, desbloqueo o reset: limpia el contador y la espera de la cuenta (no los de la IP). */
  async clearAccount(platformId: string, email: string): Promise<void> {
    const account = this.#account(platformId, email);
    await this.#redis.del(`${PREFIX}fail:${account}`, `${PREFIX}wait:${account}`);
  }
}
