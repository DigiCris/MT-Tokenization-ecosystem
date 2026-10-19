// P19.T01 [F-SES-01]/[B-PSES-03]: login de Recovery con el segundo factor y step-up ENROLLMENT/RECOVERY. La session key
// se genera en cada step-up, su privada no es extraíble y su pública es la que se manda; la PlatformSession emitida
// tiene que ser la pedida (scope y wallet) y el reloj se alinea con su `issuedAt`.
import { describe, expect, it } from 'vitest';
import { ApiError, ServerClock } from '../api/client.ts';
import type { PlatformSessionView, RecoveryApi, StepUpScope } from '../api/recovery-api.ts';
import { verifyP256, signP256 } from '../api/session-key.ts';
import {
  finishStepUp,
  needsSecondFactor,
  secondFactor,
  signIn,
  startStepUp,
  codeExpiryText,
  StepUpError,
  stepUpFailure,
} from './account.ts';

const WALLET = '7d2e3f40-1a2b-4c5d-8e9f-a0b1c2d3e4f5';
const user = {
  id: 'u1',
  email: 'ana@example.test',
  emailVerified: true,
  totpEnabled: true,
  locale: 'es-AR',
  timeZone: 'America/Argentina/Buenos_Aires',
  createdAt: '2026-10-18T00:00:00Z',
};

function fakeApi(issued: Partial<PlatformSessionView> = {}) {
  const calls: { name: string; body: unknown }[] = [];
  const clock = new ServerClock();
  const api = {
    client: { clock },
    login: (body: unknown) => {
      calls.push({ name: 'login', body });
      const { totp } = body as { totp?: string };
      if (totp === undefined) {
        return Promise.reject(new ApiError(401, 'TOTP_REQUIRED', 'TOTP', null, null));
      }
      return Promise.resolve({ user, csrfToken: 'csrf' });
    },
    startStepUp: (body: { scope: StepUpScope; walletId?: string }) => {
      calls.push({ name: 'startStepUp', body });
      return Promise.resolve({ challengeId: 'challenge-1', expiresAt: '2026-10-18T00:10:00Z' });
    },
    finishStepUp: (body: unknown) => {
      calls.push({ name: 'finishStepUp', body });
      const start = calls.find((c) => c.name === 'startStepUp')?.body as { scope: StepUpScope; walletId?: string };
      return Promise.resolve({
        token: 'platform-token',
        csrfToken: 'csrf-2',
        session: {
          id: 'ps-1',
          scope: start.scope,
          authMethod: 'STEP_UP' as const,
          walletId: start.walletId ?? WALLET,
          safe: null,
          issuedAt: new Date(Date.now() + 120_000).toISOString(),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          ...issued,
        },
      });
    },
  } as unknown as Pick<RecoveryApi, 'login' | 'startStepUp' | 'finishStepUp' | 'client'>;
  return { api, calls, clock };
}

describe('login', () => {
  it('sin segundo factor la cuenta lo pide; con el TOTP entra', async () => {
    const { api, calls } = fakeApi();
    const missing = signIn(api, { email: ' ana@example.test ', password: 'x', second: '' });
    await expect(missing).rejects.toBeInstanceOf(ApiError);
    expect(needsSecondFactor(await missing.catch((e: unknown) => e))).toBe(true);
    await expect(signIn(api, { email: 'ana@example.test', password: 'x', second: '123456' })).resolves.toEqual(user);
    expect(calls.map((c) => c.body)).toEqual([
      { email: 'ana@example.test', password: 'x' },
      { email: 'ana@example.test', password: 'x', totp: '123456' },
    ]);
  });

  it('6 dígitos son TOTP; otra cosa, un código de recuperación', () => {
    expect(secondFactor('')).toEqual({});
    expect(secondFactor(' 654321 ')).toEqual({ totp: '654321' });
    expect(secondFactor('ABCD-EFGH-1234')).toEqual({ recoveryCode: 'ABCD-EFGH-1234' });
    expect(needsSecondFactor(new Error('x'))).toBe(false);
  });
});

describe('step-up', () => {
  it('session key nueva y no extraíble: la pública que se manda verifica lo que firma la privada', async () => {
    const { api, calls } = fakeApi();
    const pending = await startStepUp(api, 'ENROLLMENT', WALLET);
    expect(pending.key.privateKey.extractable).toBe(false);
    const sent = calls[0]?.body as { sessionPublicKey: Parameters<typeof verifyP256>[0]; walletId: string };
    expect(sent.walletId).toBe(WALLET);
    expect(await verifyP256(sent.sessionPublicKey, 'm', await signP256(pending.key.privateKey, 'm'))).toBe(true);
    const other = await startStepUp(api, 'ENROLLMENT', WALLET);
    expect(other.key.publicJwk).not.toEqual(pending.key.publicJwk);
  });

  it('el código vence cuando dice el backend: «El código vence a las HH:MM.» con la hora local', async () => {
    const { api } = fakeApi();
    const pending = await startStepUp(api, 'ENROLLMENT', WALLET);
    expect(pending.expiresAt).toBe('2026-10-18T00:10:00Z');
    expect(codeExpiryText(pending.expiresAt, 'America/Argentina/Buenos_Aires')).toBe('El código vence a las 21:10.');
    expect(codeExpiryText(pending.expiresAt, 'UTC')).toBe('El código vence a las 00:10.');
  });

  it('con el código: PlatformSession con la session key del pedido y el reloj alineado al servidor', async () => {
    const { api, calls, clock } = fakeApi();
    const pending = await startStepUp(api, 'RECOVERY');
    const session = await finishStepUp(api, pending, { code: ' 12345678 ', second: '' });
    expect(session.auth).toEqual({ token: 'platform-token', sessionId: 'ps-1', key: pending.key.privateKey });
    expect(session.view.scope).toBe('RECOVERY');
    expect(calls.at(-1)?.body).toEqual({ challengeId: 'challenge-1', code: '12345678' });
    expect(clock.nowMs() - Date.now()).toBeGreaterThan(100_000);
  });

  it('una PlatformSession de otro scope u otra wallet no se usa', async () => {
    const scope = fakeApi({ scope: 'RECOVERY' });
    const pending = await startStepUp(scope.api, 'ENROLLMENT', WALLET);
    await expect(finishStepUp(scope.api, pending, { code: '1', second: '' })).rejects.toBeInstanceOf(StepUpError);
    const wallet = fakeApi({ walletId: '00000000-0000-4000-8000-000000000000' });
    const forWallet = await startStepUp(wallet.api, 'RECOVERY', WALLET);
    await expect(finishStepUp(wallet.api, forWallet, { code: '1', second: '' })).rejects.toThrow('otra wallet');
  });

  it('errores: pedir el segundo factor o empezar de nuevo (el código del email ya se usó)', () => {
    expect(stepUpFailure(new ApiError(401, 'SECOND_FACTOR_REQUIRED', 't', null, null))).toBe('SECOND_FACTOR');
    expect(stepUpFailure(new ApiError(401, 'REAUTH_FAILED', 't', null, null))).toBe('RESTART');
    expect(stepUpFailure(new ApiError(400, 'INVALID_CODE', 't', null, null))).toBeNull();
    expect(stepUpFailure(new Error('x'))).toBeNull();
  });
});
