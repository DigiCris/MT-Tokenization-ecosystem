// P18: lo preparado y no firmado se cancela en el backend (libera el nonce) cuando la verificación propia falla o el
// usuario abandona el review; nunca se cancela lo que ya está firmado ni se insiste si el backend ya no lo tiene CREATED.
import { describe, expect, it, vi } from 'vitest';
import type { PlatformAuth } from '../api/request-signature.ts';
import type { OperationStatus } from '../api/wallet-api.ts';
import { markSigned, releasePrepared, trackPrepared, unsignedOperations, verifiedOrReleased } from './prepared.ts';

const platform = { sessionId: 'session' } as unknown as PlatformAuth;

function fakeApi(states: Record<string, OperationStatus['status'] | Error>) {
  return {
    operation: vi.fn((id: string) => {
      const state = states[id];
      if (state instanceof Error) return Promise.reject(state);
      return Promise.resolve({ id, status: state ?? 'CREATED' } as OperationStatus);
    }),
    cancelOperation: vi.fn(() => Promise.resolve({ operation: {} as OperationStatus, noop: null })),
  };
}

describe('operaciones preparadas sin firmar', () => {
  it('verificación que falla: cancela lo preparado (sólo lo CREATED) y propaga el error', async () => {
    const api = fakeApi({ a: 'CREATED', b: 'USER_SIGNED' });
    const failure = new Error('no coincide');
    await expect(
      verifiedOrReleased(api, platform, [{ operationId: 'a' }, { operationId: 'b' }], () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(api.cancelOperation).toHaveBeenCalledTimes(1);
    expect(api.cancelOperation).toHaveBeenCalledWith(platform, 'a');
    expect(unsignedOperations()).toEqual([]);
  });

  it('verificación que pasa: queda pendiente hasta la firma y no se cancela nada', async () => {
    const api = fakeApi({});
    await expect(verifiedOrReleased(api, platform, [{ operationId: 'c' }], () => Promise.resolve(42))).resolves.toBe(
      42,
    );
    expect(unsignedOperations()).toEqual(['c']);
    markSigned('c');
    expect(unsignedOperations()).toEqual([]);
    await releasePrepared(api, platform);
    expect(api.operation).not.toHaveBeenCalled();
    expect(api.cancelOperation).not.toHaveBeenCalled();
  });

  it('review abandonado: el próximo prepare libera lo que quedó sin firmar, aunque el backend falle', async () => {
    trackPrepared([{ operationId: 'd' }, { operationId: 'e' }, { operationId: 'f' }]);
    const api = fakeApi({ d: 'CREATED', e: new Error('red'), f: 'EXPIRED' });
    await releasePrepared(api, platform);
    expect(api.operation).toHaveBeenCalledTimes(3);
    expect(api.cancelOperation).toHaveBeenCalledTimes(1);
    expect(api.cancelOperation).toHaveBeenCalledWith(platform, 'd');
    expect(unsignedOperations()).toEqual([]);
  });

  it('una cancelación rechazada por el backend no rompe la liberación del resto', async () => {
    trackPrepared([{ operationId: 'g' }, { operationId: 'h' }]);
    const api = fakeApi({});
    api.cancelOperation.mockRejectedValueOnce(new Error('409'));
    await releasePrepared(api, platform);
    expect(api.cancelOperation).toHaveBeenCalledTimes(2);
    expect(unsignedOperations()).toEqual([]);
  });
});
