// Passwords de cuenta [B-AUTH-01]: 12–128 caracteres (contados como puntos de código tras NFKC), fuera de la lista de
// passwords comunes y sin contener la parte local del email. Hash Argon2id (m = 64 MiB, t = 3, p = 1) sobre
// base64(HMAC-SHA256(PASSWORD_PEPPER_vN, password)); se guarda la versión del pepper para poder rotarlo. El HMAC va en
// base64 porque `verify` de @node-rs/argon2 sólo acepta entradas UTF-8 válidas (con bytes crudos nunca verificaría).
import { createHmac } from 'node:crypto';
import { hash, verify, type Algorithm, type Options } from '@node-rs/argon2';
import type { Secret } from '../config/secret.ts';
import { commonPasswords } from './common-passwords.ts';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Argon2id de [B-AUTH-01]. `2` = Argon2id: el enum de la librería es `const enum` y sólo se importa como tipo. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- const enum ambiental de @node-rs/argon2 (no importable en runtime con erasableSyntaxOnly)
export const ARGON2ID = 2 as Algorithm;

export const ARGON2_OPTIONS: Options = {
  algorithm: ARGON2ID,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
};

export type PasswordProblem = 'TOO_SHORT' | 'TOO_LONG' | 'COMMON' | 'CONTAINS_EMAIL';

/** Largo en puntos de código (un emoji o una letra con tilde compuesta cuentan como uno tras NFKC). */
export function codePointLength(value: string): number {
  let length = 0;
  for (const _codePoint of value) length++;
  return length;
}

export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

export function passwordPolicyProblem(password: string, email?: string): PasswordProblem | null {
  const normalized = normalizePassword(password);
  const length = codePointLength(normalized);
  if (length < PASSWORD_MIN_LENGTH) return 'TOO_SHORT';
  if (length > PASSWORD_MAX_LENGTH) return 'TOO_LONG';
  const lower = normalized.toLowerCase();
  if (commonPasswords(PASSWORD_MIN_LENGTH).has(lower)) return 'COMMON';
  const local = email?.split('@')[0]?.toLowerCase();
  if (local !== undefined && local.length >= 4 && lower.includes(local)) return 'CONTAINS_EMAIL';
  return null;
}

export class PasswordHasher {
  readonly #peppers: ReadonlyMap<number, Secret<Buffer>>;
  readonly #current: number;
  #dummy: Promise<string> | undefined;

  constructor(peppers: ReadonlyMap<number, Secret<Buffer>>) {
    if (peppers.size === 0) throw new Error('falta al menos un pepper de password');
    this.#peppers = peppers;
    this.#current = Math.max(...peppers.keys());
  }

  /** Versión de pepper con la que se hashean los passwords nuevos. */
  get currentVersion(): number {
    return this.#current;
  }

  #prehash(password: string, version: number): string {
    const pepper = this.#peppers.get(version);
    if (!pepper) throw new Error(`pepper v${String(version)} no configurado`);
    return createHmac('sha256', pepper.reveal()).update(normalizePassword(password), 'utf8').digest('base64');
  }

  async hash(password: string): Promise<{ hash: string; pepperVersion: number }> {
    return { hash: await hash(this.#prehash(password, this.#current), ARGON2_OPTIONS), pepperVersion: this.#current };
  }

  /** false también si el pepper de esa versión ya no está configurado. */
  async verify(stored: string, pepperVersion: number, password: string): Promise<boolean> {
    if (!this.#peppers.has(pepperVersion)) return false;
    try {
      return await verify(stored, this.#prehash(password, pepperVersion));
    } catch {
      return false;
    }
  }

  /** El hash quedó con un pepper anterior: conviene rehashear tras un login correcto. */
  needsRehash(pepperVersion: number): boolean {
    return pepperVersion !== this.#current;
  }

  /**
   * Gasta el mismo tiempo que una verificación real (usuario inexistente o bloqueado): la respuesta no revela si la
   * cuenta existe ([B-AUTH-03]).
   */
  async burn(password: string): Promise<false> {
    this.#dummy ??= hash(this.#prehash('dummy-password-for-timing', this.#current), ARGON2_OPTIONS);
    await verify(await this.#dummy, this.#prehash(password, this.#current)).catch(() => false);
    return false;
  }
}
