// "Perdí mi Password U" (P17.T07, P15.T04): sin la Password U no hay forma de usar U, así que se genera U' con su
// Password U' y sus backups, se registra con la PlatformSession U_REPLACEMENT (step-up por email + TOTP) junto con la
// KeyAcceptance que firma U', y R propone la rotación U → U' desde la app Recovery (timelock de 48 h, cancelable). La
// app entrega el handoff a Recovery con un link (fragmento: no llega a servidores) y su QR, y muestra la dirección de U'
// que generó ella misma (nunca la que informa la plataforma): en Recovery el usuario tipea esos 10 grupos y Recovery
// los compara con la U' que informa el backend, así una U' sustituida en el camino no pasa sin que se note.
import { isAddress, isAddressEqual, type Address } from 'viem';
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

/** Si la plataforma dice haber registrado otra U' que la que generó esta app, no se sigue a Recovery. */
export const OTHER_USER_KEY_TEXT =
  'La plataforma informa otra clave U nueva que la que generó esta app: no sigas en la app Recovery ni firmes nada con tu clave R.';

/** Junto a la dirección de U' en la pantalla final: qué hacer con ella en Recovery. */
export const NEW_USER_KEY_COMPARE_TEXT =
  'En la app Recovery te vamos a pedir que copies estos 10 grupos (los que siguen al «0x»): comparalos con calma; si Recovery muestra otra dirección, no firmes.';

/**
 * Con los backups hechos: KeyAcceptance de U' y registro de U' → borrador de rotación para que R la proponga. La U'
 * que devuelve es la que generó esta app (la que se muestra y va en el handoff); si la plataforma informa otra, falla.
 */
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
  if (!isAddress(registered.userKey) || !isAddressEqual(registered.userKey, draft.address)) {
    throw new Error(OTHER_USER_KEY_TEXT);
  }
  return { rotationId: registered.rotationId, walletId: registered.walletId, userKey: draft.address };
}

/**
 * Handoff a Recovery: la rotación y la U' esperada en el fragmento. En Recovery el usuario tipea los 10 grupos de U'
 * que ve en la pantalla final de esta app, y Recovery los compara con la U' que informa el backend.
 */
export function recoveryHandoffUrl(recoveryOrigin: string, rotationId: string, newKey: Address): string {
  const url = new URL('/recover-u', recoveryOrigin);
  url.hash = new URLSearchParams({ rid: rotationId, u: newKey }).toString();
  return url.toString();
}
