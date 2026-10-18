// P18.T02: la verificación propia se corre una vez por desbloqueo (PlatformSession) y se recuerda; si falla por un
// error de lectura, el próximo intento vuelve a leer; cada ítem fallido tiene un texto para el usuario.
import type { Address } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { failureText, verifyOnUnlock } from './gate.ts';

vi.mock('./verify.ts', () => ({
  verifySafe: vi.fn(),
}));
// La config embebida del build (módulo virtual de Vite) no existe en Vitest: se reemplaza por una mínima.
vi.mock('../config/index.ts', () => ({
  appConfig: { platformId: 'mt-default' },
  systemContracts: { contracts: {}, signerAttestationPublicKey: '' },
}));

const { verifySafe } = await import('./verify.ts');
const SAFE: Address = '0x2Ffa853A9213C92A16295C55FA6A5b27A6498688';
const U: Address = '0x79406Eb1d6abdA075A9789DBD7d31626FEFE2904';

describe('verificación por desbloqueo', () => {
  it('una vez por sesión; tras un error de lectura se reintenta', async () => {
    const run = vi.mocked(verifySafe);
    run.mockResolvedValue({ ok: true, state: {} as never });
    const reader = {} as never;
    await verifyOnUnlock('s1', reader, { safe: SAFE, userKey: U });
    await verifyOnUnlock('s1', reader, { safe: SAFE, userKey: U });
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRejectedValueOnce(new Error('RPC caído'));
    await expect(verifyOnUnlock('s2', reader, { safe: SAFE, userKey: U })).rejects.toThrow('RPC caído');
    await expect(verifyOnUnlock('s2', reader, { safe: SAFE, userKey: U })).resolves.toMatchObject({ ok: true });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('texto de cada ítem fallido', () => {
    expect(failureText('CODEHASH_GUARD')).toMatch(/"guard" no es el fijado/);
    expect(failureText('OWNERS')).toMatch(/firmantes/);
    expect(failureText('USER_KEY')).toMatch(/U vigente/);
    expect(failureText('OTRO')).toBe('OTRO');
  });
});
