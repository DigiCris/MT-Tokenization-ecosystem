// "Perdí mi Password U" (P17.T07, P15.T04): sin la Password U no hay forma de usar U, así que se genera U' con su
// Password U' y sus backups, se registra con la PlatformSession U_REPLACEMENT (step-up por email + TOTP) junto con la
// KeyAcceptance que firma U', y R propone la rotación U → U' desde la app Recovery (timelock de 48 h, cancelable). La
// app entrega el handoff a Recovery con un link (fragmento: no llega a servidores) y su QR.
import type { Address } from 'viem';
import { randomBytes, toHex, zeroize } from '../../crypto/bytes.ts';
import { sealKey, type KeyEnvelope } from '../../crypto/envelope.ts';
import type { Argon2, KdfParams } from '../../crypto/kdf.ts';
import { signTypedDataWithKey } from '../../crypto/sign.ts';
import { keyAcceptance } from '../../crypto/typed-data.ts';
import type { StorageFlags, WalletApi } from '../../api/wallet-api.ts';
import { deriveForNewEnvelope, type DraftKey } from '../../onboarding/user-key.ts';
import type { StepUpSession } from '../../session/step-up.ts';
import { startRegistration } from '../../unlock/opaque.ts';

export interface PreparedReplacement {
  envelope: KeyEnvelope;
  encryptionKey: CryptoKey;
  registrationRecord: string;
  kdf: KdfParams;
  keyVersion: number;
}

/**
 * Sobre de U' (con la versión que asigna el backend) y su registro OPAQUE (todavía sin guardar: el backend lo guarda
 * PENDING recién con la KeyAcceptance, después de los backups).
 */
export async function prepareReplacement(
  api: WalletApi,
  stepUp: StepUpSession,
  draft: DraftKey,
  password: string,
  platformId: string,
  argon2: Argon2,
): Promise<PreparedReplacement> {
  const walletId = stepUp.session.walletId;
  if (walletId === null) throw new Error('la PlatformSession U_REPLACEMENT no está atada a una wallet');
  const { encryptionKey, authSecret, kdf } = await deriveForNewEnvelope(password, 'U', argon2);
  if (authSecret === null) throw new Error('falta AuthSecret_U');
  try {
    const registration = await startRegistration(authSecret);
    const response = await api.userKeyOpaqueRegistration(stepUp.platform, walletId, registration.registrationRequest);
    const registrationRecord = registration.finish(response.registrationResponse);
    const envelope = await sealKey(
      draft.key,
      encryptionKey,
      { platformId, chainId: 8453, walletId, role: 'U', keyAddress: draft.address, keyVersion: response.keyVersion },
      kdf,
    );
    return { envelope, encryptionKey, registrationRecord, kdf, keyVersion: response.keyVersion };
  } finally {
    zeroize(authSecret);
  }
}

/** Con los backups hechos: KeyAcceptance de U' y registro de U' → borrador de rotación para que R la proponga. */
export async function registerReplacement(
  api: WalletApi,
  stepUp: StepUpSession,
  draft: DraftKey,
  prepared: PreparedReplacement,
  storageFlags: StorageFlags,
  walletFactory: Address,
): Promise<{ rotationId: string; walletId: string; userKey: Address }> {
  const nonce = toHex(randomBytes(32));
  const signature = signTypedDataWithKey(
    draft.key,
    keyAcceptance(walletFactory, { walletId: prepared.envelope.walletId, role: 'U', newKey: draft.address, nonce }),
  );
  const registered = await api.registerReplacementUserKey(stepUp.platform, {
    userKey: draft.address,
    kdfParams: prepared.kdf,
    storageFlags,
    registrationRecord: prepared.registrationRecord,
    keyAcceptance: { nonce, signature },
  });
  return { rotationId: registered.rotationId, walletId: registered.walletId, userKey: registered.userKey };
}

/** Handoff a Recovery: la rotación y la U' esperada en el fragmento; Recovery compara con lo que informe el backend. */
export function recoveryHandoffUrl(recoveryOrigin: string, rotationId: string, newKey: Address): string {
  const url = new URL('/recover-u', recoveryOrigin);
  url.hash = new URLSearchParams({ rid: rotationId, u: newKey }).toString();
  return url.toString();
}
