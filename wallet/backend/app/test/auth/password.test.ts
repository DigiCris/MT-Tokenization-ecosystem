// [B-AUTH-01]: política de passwords de cuenta (12–128 puntos de código tras NFKC, lista de comunes de SecLists, sin
// la parte local del email) y hash Argon2id m=64 MiB, t=3, p=1 sobre HMAC-SHA256(pepper versionado, password).
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { VENDORED_LIST_SHA256, commonPasswords } from '../../src/auth/common-passwords.ts';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasswordHasher,
  passwordPolicyProblem,
} from '../../src/auth/password.ts';
import { Secret } from '../../src/config/secret.ts';

const DATA_DIR = new URL('../../data/common-passwords/', import.meta.url);
const pepper = () => new Secret(randomBytes(32));

describe('política de passwords', () => {
  it('largo mínimo y máximo contados como puntos de código tras NFKC', () => {
    expect(passwordPolicyProblem('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe('TOO_SHORT');
    expect(passwordPolicyProblem('Zx9-k2Lm-Qw7')).toBeNull();
    expect(passwordPolicyProblem('x'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe('TOO_LONG');
    expect(passwordPolicyProblem(`${'x'.repeat(PASSWORD_MAX_LENGTH - 4)}Ab1-`)).toBeNull();
    // 12 emojis = 12 puntos de código (24 unidades UTF-16): válido.
    expect(passwordPolicyProblem('🔐🦊🌵🎲🛰️🧩🪐🐙🍋🧭🎻🦉'.normalize('NFKC'))).toBeNull();
    // "ｆｕｌｌｗｉｄｔｈ" (ancho completo) se normaliza a ASCII antes de contar y comparar.
    expect(passwordPolicyProblem('ｑ１ｗ２ｅ３ｒ４ｔ５ｙ６')).toBe('COMMON');
  });

  it('rechaza las passwords de la lista vendorizada, sin importar mayúsculas', () => {
    expect(passwordPolicyProblem('q1w2e3r4t5y6')).toBe('COMMON');
    expect(passwordPolicyProblem('QWERTY123456')).toBe('COMMON');
    expect(passwordPolicyProblem('sojdlg123aljg')).toBe('COMMON');
    expect(commonPasswords(PASSWORD_MIN_LENGTH).size).toBeGreaterThan(1_000);
  });

  it('rechaza passwords que contienen la parte local del email', () => {
    expect(passwordPolicyProblem('mi-clave-ana.perez-2026', 'ana.perez@dominio.com')).toBe('CONTAINS_EMAIL');
    expect(passwordPolicyProblem('MI-CLAVE-ANA.PEREZ-2026', 'ana.perez@dominio.com')).toBe('CONTAINS_EMAIL');
    // Partes locales muy cortas no se consideran (evita falsos positivos con "ab@…").
    expect(passwordPolicyProblem('tablero-ab-azul-77', 'ab@dominio.com')).toBeNull();
  });

  it('la lista vendorizada coincide con el SHA-256 fijado en el código y en su README', () => {
    const content = gunzipSync(readFileSync(new URL('100k-most-used-passwords-NCSC.txt.gz', DATA_DIR)));
    expect(createHash('sha256').update(content).digest('hex')).toBe(VENDORED_LIST_SHA256);
    expect(readFileSync(new URL('README.md', DATA_DIR), 'utf8')).toContain(VENDORED_LIST_SHA256);
    expect(readFileSync(new URL('LICENSE-SecLists', DATA_DIR), 'utf8')).toContain('MIT License');
  });
});

describe('PasswordHasher', () => {
  it('Argon2id con los parámetros de [B-AUTH-01]; verifica la correcta y rechaza otra', async () => {
    const hasher = new PasswordHasher(new Map([[1, pepper()]]));
    const { hash, pepperVersion } = await hasher.hash('correcta-Larga-2026');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(pepperVersion).toBe(1);
    expect(await hasher.verify(hash, 1, 'correcta-Larga-2026')).toBe(true);
    expect(await hasher.verify(hash, 1, 'correcta-larga-2026')).toBe(false);
    expect(await hasher.verify(hash, 1, '')).toBe(false);
  });

  it('el pepper participa del hash: con otro pepper la misma password no verifica', async () => {
    const a = new PasswordHasher(new Map([[1, pepper()]]));
    const b = new PasswordHasher(new Map([[1, pepper()]]));
    const { hash } = await a.hash('misma-password-2026');
    expect(await b.verify(hash, 1, 'misma-password-2026')).toBe(false);
  });

  it('normaliza NFKC: la misma password escrita con otra forma Unicode verifica', async () => {
    const hasher = new PasswordHasher(new Map([[1, pepper()]]));
    const { hash } = await hasher.hash('café-con-leche-2026'.normalize('NFC'));
    expect(await hasher.verify(hash, 1, 'café-con-leche-2026'.normalize('NFD'))).toBe(true);
  });

  it('rotación de pepper: los hashes nuevos usan la versión más alta y los viejos piden rehash', async () => {
    const v1 = pepper();
    const old = new PasswordHasher(new Map([[1, v1]]));
    const { hash } = await old.hash('password-de-antes-2026');
    const rotated = new PasswordHasher(
      new Map([
        [1, v1],
        [2, pepper()],
      ]),
    );
    expect(rotated.currentVersion).toBe(2);
    expect(await rotated.verify(hash, 1, 'password-de-antes-2026')).toBe(true);
    expect(rotated.needsRehash(1)).toBe(true);
    const fresh = await rotated.hash('password-de-antes-2026');
    expect(fresh.pepperVersion).toBe(2);
    expect(rotated.needsRehash(fresh.pepperVersion)).toBe(false);
    // Un pepper retirado de la configuración ya no verifica (fuerza el reset).
    const retired = new PasswordHasher(new Map([[2, pepper()]]));
    expect(await retired.verify(hash, 1, 'password-de-antes-2026')).toBe(false);
  });

  it('burn gasta un hash completo y siempre devuelve false', async () => {
    const hasher = new PasswordHasher(new Map([[1, pepper()]]));
    expect(await hasher.burn('dummy-password-for-timing')).toBe(false);
    const started = performance.now();
    expect(await hasher.burn('cualquier-cosa')).toBe(false);
    // Argon2id m=64 MiB, t=3: nunca es instantáneo.
    expect(performance.now() - started).toBeGreaterThan(10);
  });

  it('un hash guardado corrupto no verifica (y no tira)', async () => {
    const hasher = new PasswordHasher(new Map([[1, pepper()]]));
    expect(await hasher.verify('no-es-un-hash-argon2', 1, 'cualquier-password')).toBe(false);
  });

  it('exige al menos un pepper', () => {
    expect(() => new PasswordHasher(new Map())).toThrow(/pepper/);
  });
});
