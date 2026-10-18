// Desbloqueo de la Wallet ([F-SES-02], [F-KEY-05]): Password U → Argon2id (worker) → K_U (CryptoKey AES-GCM no
// exportable) y AuthSecret_U → OPAQUE (KE1/KE3) con una session key P-256 no exportable atada por HMAC → PlatformSession
// OPERATIONS de 15 minutos. Antes de OPAQUE se comprueba la Password U contra el sobre (sin contactar al backend ni
// gastar intentos): U se descifra, se verifica su dirección y se borra en el acto.
import { zeroize } from '../crypto/bytes.ts';
import { EnvelopeError, keysForEnvelope, openEnvelope, type KeyEnvelope } from '../crypto/envelope.ts';
import type { Argon2 } from '../crypto/kdf.ts';
import { normalizePassword } from '../crypto/password.ts';
import type { PlatformAuth } from '../api/request-signature.ts';
import { generateSessionKey, sessionKeyBinding } from '../api/session-key.ts';
import type { PlatformSessionView, WalletApi } from '../api/wallet-api.ts';
import { startLogin } from './opaque.ts';

export interface UnlockedWallet {
  envelope: KeyEnvelope;
  /** K_U: no exportable; U se descifra sólo para cada firma. */
  encryptionKey: CryptoKey;
  platform: PlatformAuth;
  session: PlatformSessionView;
}

export class UnlockError extends Error {
  override name = 'UnlockError';
  readonly reason: 'WRONG_PASSWORD' | 'RECORD_MISMATCH';

  constructor(reason: UnlockError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

export async function unlockWallet(
  api: WalletApi,
  envelope: KeyEnvelope,
  password: string,
  argon2: Argon2,
): Promise<UnlockedWallet> {
  const keys = await keysForEnvelope(envelope, normalizePassword(password), argon2);
  const authSecret = keys.authSecret;
  if (authSecret === null) throw new TypeError('el sobre no es de U');
  try {
    try {
      zeroize(await openEnvelope(envelope, keys.encryptionKey));
    } catch (error) {
      if (error instanceof EnvelopeError) throw new UnlockError('WRONG_PASSWORD', 'La Password U no abre este sobre');
      throw error;
    }
    const key = await generateSessionKey();
    const login = await startLogin(authSecret);
    const started = await api.opaqueStart({
      startLoginRequest: login.startLoginRequest,
      sessionPublicKey: key.publicJwk,
      walletId: envelope.walletId,
    });
    const finished = login.finish(started.loginResponse);
    if (finished === null) {
      throw new UnlockError(
        'RECORD_MISMATCH',
        'Este sobre no corresponde al registro vigente de tu wallet (¿cambiaste la Password U en otro dispositivo?)',
      );
    }
    const issued = await api.opaqueFinish({
      loginAttemptId: started.loginAttemptId,
      finishLoginRequest: finished.finishLoginRequest,
      sessionKeyBinding: await sessionKeyBinding(finished.sessionKey, key.thumbprint, started.loginAttemptId),
    });
    return {
      envelope,
      encryptionKey: keys.encryptionKey,
      platform: { token: issued.token, sessionId: issued.session.id, key },
      session: issued.session,
    };
  } finally {
    zeroize(authSecret);
  }
}
