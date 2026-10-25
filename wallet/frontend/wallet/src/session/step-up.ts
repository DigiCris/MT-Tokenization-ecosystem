// Step-up para los scopes restringidos de Wallet ([B-PSES-03]): ONBOARDING, U_REPLACEMENT y KEY_RESTORE. Genera la
// session key P-256 no exportable, pide el código por email y, con el código (+ TOTP o código de recuperación si la
// cuenta tiene TOTP), obtiene la PlatformSession del scope. El finish rota la sesión de cuenta: el cliente toma el CSRF
// nuevo de la respuesta.
import type { Address, Hex } from 'viem';
import type { PlatformAuth } from '../api/request-signature.ts';
import { generateSessionKey, type SessionKey } from '../api/session-key.ts';
import type { PlatformSessionView, StepUpScope, WalletApi } from '../api/wallet-api.ts';

export interface PendingStepUp {
  scope: StepUpScope;
  challengeId: string;
  expiresAt: string;
  key: SessionKey;
  /** KEY_RESTORE: lo firma la U restaurada en KeyRestore. */
  keyRestoreNonce: Hex | null;
}

export interface StepUpSession {
  platform: PlatformAuth;
  session: PlatformSessionView;
}

export async function startStepUp(api: WalletApi, scope: StepUpScope, walletId?: string): Promise<PendingStepUp> {
  const key = await generateSessionKey();
  const started = await api.stepUpStart({
    scope,
    sessionPublicKey: key.publicJwk,
    ...(walletId === undefined ? {} : { walletId }),
  });
  return {
    scope,
    challengeId: started.challengeId,
    expiresAt: started.expiresAt,
    key,
    keyRestoreNonce: started.keyRestoreNonce ?? null,
  };
}

export interface StepUpCodes {
  code: string;
  totp?: string;
  recoveryCode?: string;
  keyRestore?: { keyAddress: Address; signature: Hex };
}

export async function finishStepUp(api: WalletApi, pending: PendingStepUp, codes: StepUpCodes): Promise<StepUpSession> {
  const issued = await api.stepUpFinish({ challengeId: pending.challengeId, ...codes });
  if (issued.session.scope !== pending.scope) throw new Error('el backend emitió una PlatformSession de otro scope');
  return {
    platform: { token: issued.token, sessionId: issued.session.id, key: pending.key },
    session: issued.session,
  };
}

/** Sesión vigente (con margen de 30 s para no empezar un request crítico a punto de vencer). */
export function isLive(session: PlatformSessionView, now: number = Date.now()): boolean {
  return liveUntil(session.expiresAt, now);
}

/** Lo mismo con sólo el vencimiento (ISO 8601) de la sesión. */
export function liveUntil(expiresAt: string, now: number = Date.now()): boolean {
  return Date.parse(expiresAt) - now > 30_000;
}

/**
 * Cuándo vence el código del step-up: la hora que informa el backend en `expiresAt` (el plazo lo fija el backend, no la
 * app), en el huso del dispositivo salvo que se pase otro.
 */
export function codeExpiryText(expiresAt: string, timeZone?: string): string {
  const time = new Date(expiresAt).toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  return `Vence a las ${time}.`;
}
