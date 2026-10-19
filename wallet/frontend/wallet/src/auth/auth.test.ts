// P17.T03: lógica de las pantallas de cuenta — a dónde ir después de iniciar sesión según la wallet y los mensajes para
// el usuario de cada error (con qué hacer). Las pantallas en sí, contra el backend real: test/browser/stack/auth.spec.ts.
import { describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '../api/problem.ts';
import type { WalletStatus, WalletView } from '../api/wallet-api.ts';
import { BackupWordsError } from '../crypto/backup-words.ts';
import type { SessionStore } from '../session/store.ts';
import { describeError } from '../ui/errors.ts';
import { afterSignIn } from './after-sign-in.ts';

function storeWith(status: WalletStatus | null): SessionStore {
  const wallet: WalletView | null =
    status === null ? null : { id: 'w', status, chainId: 8453, safe: null, createdAt: '', activatedAt: null };
  return { refreshWallet: vi.fn(() => Promise.resolve(wallet)) } as unknown as SessionStore;
}

const problem = (code: string, status: number, detail?: string) =>
  new ApiError(
    { type: 'x', title: `título ${code}`, status, code, requestId: 'r', ...(detail ? { detail } : {}) },
    code === 'RATE_LIMITED' ? 9 : null,
  );

describe('después del login', () => {
  it.each([
    [null, '/onboarding'],
    ['CREATING', '/onboarding'],
    ['ACTIVE', '/unlock'],
    ['MIGRATING', '/unlock'],
    ['SOVEREIGN_MODIFIED', '/unlock'],
    ['DEPLOYING', '/'],
    ['FAILED', '/'],
  ] as const)('wallet %s → %s', async (status, path) => {
    expect(await afterSignIn(storeWith(status))).toBe(path);
  });
});

describe('mensajes de error', () => {
  it('indicaciones propias, nunca textos del backend, y errores locales', () => {
    expect(describeError(problem('ACCOUNT_LOCKED', 403))).toContain('Pedí un código de desbloqueo');
    expect(describeError(problem('RATE_LIMITED', 429))).toContain('podés reintentar en 9 s');
    // Revisión de ADR-033 (MEDIO 2): ni el título ni el detalle del backend llegan a la pantalla.
    const conflict = 'La plataforma no puede hacer esto en el estado actual: recargá la pantalla y reintentá.';
    expect(describeError(problem('CONFLICT', 409, 'detalle'))).toBe(conflict);
    expect(describeError(problem('CONFLICT', 409))).toBe(conflict);
    expect(describeError(new NetworkError('no se pudo contactar a la API'))).toContain('Revisá tu conexión');
    expect(describeError(new BackupWordsError('el checksum no coincide'))).toBe('el checksum no coincide');
    expect(describeError(new Error('otra cosa'))).toBe('otra cosa');
    expect(describeError('raro')).toBe('Algo salió mal. Reintentá en un momento.');
  });
});
