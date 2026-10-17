// [B-AUTH-09] Unidades de TOTP y códigos de recuperación: formato, ventana de ±1 paso, anti-replay y normalización.
import { describe, expect, it } from 'vitest';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  matchRecoveryCode,
  newTotpSecret,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
  totpCode,
  totpUri,
  verifyTotp,
} from '../../src/auth/totp.ts';

const T0 = Date.UTC(2026, 9, 17, 15, 0, 0);
const STEP = 30_000;

describe('verifyTotp', () => {
  const secret = newTotpSecret();

  it('acepta el paso actual y ±1; rechaza ±2 y formatos inválidos', () => {
    for (const offset of [-1, 0, 1])
      expect(verifyTotp(secret, totpCode(secret, T0 + offset * STEP), null, T0).ok, String(offset)).toBe(true);
    for (const offset of [-2, 2])
      expect(verifyTotp(secret, totpCode(secret, T0 + offset * STEP), null, T0)).toEqual({
        ok: false,
        reason: 'INVALID',
      });
    for (const token of ['12345', '1234567', 'abcdef', ''])
      expect(verifyTotp(secret, token, null, T0)).toEqual({ ok: false, reason: 'INVALID' });
  });

  it('anti-replay: un paso igual o anterior al último usado es REPLAY', () => {
    const current = verifyTotp(secret, totpCode(secret, T0), null, T0);
    if (!current.ok) throw new Error('debía validar');
    expect(verifyTotp(secret, totpCode(secret, T0), current.step, T0)).toEqual({ ok: false, reason: 'REPLAY' });
    expect(verifyTotp(secret, totpCode(secret, T0 - STEP), current.step, T0)).toEqual({ ok: false, reason: 'REPLAY' });
    expect(verifyTotp(secret, totpCode(secret, T0 + STEP), current.step, T0).ok).toBe(true);
  });

  it('el URI identifica al emisor y la cuenta', () => {
    const uri = totpUri(secret, 'ana@test.invalid');
    expect(uri).toMatch(/^otpauth:\/\/totp\/MT%20Wallet:ana%40test\.invalid\?/);
    expect(uri).toContain('issuer=MT%20Wallet');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('códigos de recuperación', () => {
  it('10 códigos únicos XXXXX-XXXXX sin caracteres ambiguos', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  });

  it('se comparan normalizados y un largo distinto nunca coincide', async () => {
    const [code = ''] = generateRecoveryCodes();
    const hashes = [await hashRecoveryCode(code)];
    expect(normalizeRecoveryCode(` ${code.toLowerCase()} `)).toBe(code.replace('-', ''));
    expect(await matchRecoveryCode(code.toLowerCase().replace('-', ' '), hashes)).toBe(0);
    expect(await matchRecoveryCode(code.slice(0, 9), hashes)).toBe(-1);
    expect(await matchRecoveryCode(`${code}X`, hashes)).toBe(-1);
    expect(await matchRecoveryCode(code, ['no-es-un-hash'])).toBe(-1);
  });
});
