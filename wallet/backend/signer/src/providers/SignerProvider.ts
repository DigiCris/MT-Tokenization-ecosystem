// Interfaz común de los providers de firma [B-SIG-04] (ADR-014). El signer-service calcula los digests (hash EIP-712
// de la SafeTx y hash de firma de la tx EIP-1559) y el provider sólo firma digests de 32 bytes con la clave indicada.
//
// Implementaciones: SelfHostedSoftwareSignerProvider (staging/producción), DevelopmentSignerProvider (el mismo, con
// guardas de desarrollo) y HardwareSignerProvider (futuro opcional, PKCS#11/YubiHSM; no se usa en V1).
import type { Address } from '../crypto/keccak.ts';
import type { EthSignature } from '../crypto/secp256k1.ts';
import type { KeyPurpose } from '../state/schema.ts';

export type ProviderName = 'development' | 'selfhosted' | 'hardware';

export interface CreatedKey {
  keyRef: string;
  address: Address;
}

export interface ProviderHealth {
  provider: ProviderName;
  shardId: string;
  ready: boolean;
  /** Motivos por los que el shard no está listo (sin datos sensibles). */
  problems: string[];
  keys: { active: number; broken: number };
}

export interface SignerProvider {
  readonly name: ProviderName;
  readonly shardId: string;
  /** Crea una clave nueva para `walletId` (o la cuenta gas tank del shard `platform` con `walletId = null`). */
  createKey(walletId: string | null, purpose?: KeyPurpose): Promise<CreatedKey>;
  getAddress(keyRef: string): Promise<Address>;
  /** Firma un digest de 32 bytes (sin prehash), low-s, con `v` de Ethereum. */
  signDigest(keyRef: string, digest: Uint8Array): Promise<EthSignature>;
  health(): Promise<ProviderHealth>;
}

export class SignerProviderError extends Error {
  override name = 'SignerProviderError';
  readonly code: 'NOT_READY' | 'KEY_NOT_FOUND' | 'KEY_UNAVAILABLE' | 'KEY_NOT_USABLE' | 'INVALID_DIGEST';

  constructor(code: SignerProviderError['code'], message: string) {
    super(message);
    this.code = code;
  }
}
