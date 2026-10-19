// Cuenta y step-up de Recovery sin React (P19.T01, [F-SES-01], [B-PSES-03], [F-SES-02]): login con la misma cuenta que
// en Wallet (y el segundo factor si la cuenta lo tiene) y el step-up ENROLLMENT o RECOVERY, que emite una PlatformSession
// de 15 min atada a una session key P-256 nueva y no extraíble generada en este navegador (la Enrollment Key). Las
// pantallas (LoginForm, StepUp) sólo muestran estos pasos.
import { ApiError } from '../api/client.ts';
import type { RecoveryApi, StepUpScope, User } from '../api/recovery-api.ts';
import { generateSessionKey, type SessionKey } from '../api/session-key.ts';
import type { PlatformSession } from '../session/store.ts';

type AccountApi = Pick<RecoveryApi, 'login' | 'startStepUp' | 'finishStepUp' | 'client'>;

/** El segundo factor escrito: 6 dígitos son TOTP; cualquier otra cosa, un código de recuperación. */
export function secondFactor(text: string): { totp: string } | { recoveryCode: string } | Record<string, never> {
  const value = text.trim();
  if (value === '') return {};
  return /^\d{6}$/.test(value) ? { totp: value } : { recoveryCode: value };
}

/** La cuenta pide el segundo factor (y el formulario tiene que mostrarlo). */
export function needsSecondFactor(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'TOTP_REQUIRED' || error.code === 'SECOND_FACTOR_REQUIRED');
}

export async function signIn(
  api: AccountApi,
  input: { email: string; password: string; second: string },
): Promise<User> {
  const { user } = await api.login({
    email: input.email.trim(),
    password: input.password,
    ...secondFactor(input.second),
  });
  return user;
}

export class StepUpError extends Error {
  override name = 'StepUpError';
}

export interface PendingStepUp {
  challengeId: string;
  key: SessionKey;
  scope: StepUpScope;
  walletId: string | null;
  /** Vencimiento del código del email (ISO 8601). */
  expiresAt: string;
}

/** Pide el código por email para una session key nueva (la privada nunca sale de WebCrypto). */
export async function startStepUp(api: AccountApi, scope: StepUpScope, walletId?: string): Promise<PendingStepUp> {
  const key = await generateSessionKey();
  const started = await api.startStepUp({
    scope,
    sessionPublicKey: key.publicJwk,
    ...(walletId === undefined ? {} : { walletId }),
  });
  return { challengeId: started.challengeId, key, scope, walletId: walletId ?? null, expiresAt: started.expiresAt };
}

/**
 * «El código vence a las HH:MM.»: la hora local en que vence el código del email (la que informa el backend, no un valor
 * fijo). Es el plazo del código, no el de la verificación (que dura 15 minutos desde que se completa).
 */
export function codeExpiryText(expiresAt: string, timeZone?: string): string {
  const time = new Date(expiresAt).toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  return `El código vence a las ${time}.`;
}

/** Con el código (y el segundo factor): la PlatformSession emitida tiene que ser la pedida (scope y wallet). */
export async function finishStepUp(
  api: AccountApi,
  pending: PendingStepUp,
  input: { code: string; second: string },
): Promise<PlatformSession> {
  const issued = await api.finishStepUp({
    challengeId: pending.challengeId,
    code: input.code.trim(),
    ...secondFactor(input.second),
  });
  if (issued.session.scope !== pending.scope) throw new StepUpError('La verificación emitida no es la pedida.');
  if (pending.walletId !== null && issued.session.walletId !== pending.walletId) {
    throw new StepUpError('La verificación emitida es de otra wallet.');
  }
  api.client.clock.observe(issued.session.issuedAt);
  return {
    auth: { token: issued.token, sessionId: issued.session.id, key: pending.key.privateKey },
    view: issued.session,
  };
}

/** Qué hacer después de un error del step-up: pedir el segundo factor o empezar de nuevo (el código ya se usó). */
export function stepUpFailure(error: unknown): 'SECOND_FACTOR' | 'RESTART' | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'SECOND_FACTOR_REQUIRED') return 'SECOND_FACTOR';
  if (error.code === 'REAUTH_FAILED') return 'RESTART';
  return null;
}
