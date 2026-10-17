// HardwareSignerProvider [B-SIG-04] (ADR-014): hardening FUTURO opcional con un HSM físico propio (PKCS#11 o YubiHSM)
// que guarda S como clave secp256k1 NO exportable. En V1 no se usa (SIGNER_PROVIDER sólo admite development |
// selfhosted): quedan la interfaz del HSM, la lógica que adapta sus firmas al formato de Ethereum y la misma suite de
// contrato que corren los otros providers (test/providers/contract-suite.test.ts). La migración se hace Safe por Safe
// rotando S por el timelock con la firma del usuario, sin exportar claves (docs/runbooks/signer-hardware-migration.md).
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToBigInt, bytesToHex, concatBytes, uint256ToBytes } from '../crypto/bytes.ts';
import type { Address } from '../crypto/keccak.ts';
import { publicKeyToAddress, recoverStrict, type EthSignature } from '../crypto/secp256k1.ts';
import type { KeyRegistry } from '../state/key-registry.ts';
import type { KeyPurpose } from '../state/schema.ts';
import { SignerProviderError, type CreatedKey, type ProviderHealth, type SignerProvider } from './SignerProvider.ts';

const N = secp256k1.Point.CURVE().n;

/** Sesión con un HSM (PKCS#11 `CKM_ECDSA` sobre secp256k1, o el equivalente de YubiHSM). */
export interface HsmSession {
  /** Genera una clave secp256k1 no exportable con la etiqueta dada; devuelve su clave pública sin comprimir (65 bytes). */
  generateSecp256k1(label: string): Promise<Uint8Array>;
  /** Clave pública sin comprimir de la clave con esa etiqueta. */
  publicKey(label: string): Promise<Uint8Array>;
  /** ECDSA sobre un digest de 32 bytes: r ‖ s (64 bytes), con s alto o bajo y sin bit de recuperación. */
  signDigest(label: string, digest: Uint8Array): Promise<Uint8Array>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Adapta una firma (r, s) de un HSM al formato de Ethereum: s normalizado a la mitad baja (low-s, como exigen Safe y
 * el signer) y `v` calculado probando el bit de recuperación contra la dirección de la clave.
 */
export function toEthSignature(rs: Uint8Array, digest: Uint8Array, address: Address): EthSignature {
  if (rs.length !== 64) throw new SignerProviderError('KEY_UNAVAILABLE', 'firma del HSM de longitud inválida');
  const r = bytesToBigInt(rs.subarray(0, 32));
  let s = bytesToBigInt(rs.subarray(32, 64));
  if (r <= 0n || r >= N || s <= 0n || s >= N)
    throw new SignerProviderError('KEY_UNAVAILABLE', 'firma del HSM fuera de rango');
  if (s > N >> 1n) s = N - s;
  const rb = uint256ToBytes(r);
  const sb = uint256ToBytes(s);
  for (const v of [27, 28] as const) {
    const candidate = bytesToHex(concatBytes(rb, sb, Uint8Array.of(v)));
    try {
      if (recoverStrict(digest, candidate).toLowerCase() === address.toLowerCase()) {
        return { r: bytesToHex(rb), s: bytesToHex(sb), v, yParity: v === 27 ? 0 : 1, bytes: candidate };
      }
    } catch {
      // probar el otro bit
    }
  }
  throw new SignerProviderError('KEY_UNAVAILABLE', 'la firma del HSM no corresponde a la clave');
}

export class HardwareSignerProvider implements SignerProvider {
  readonly name = 'hardware' as const;
  readonly shardId: string;
  readonly #session: HsmSession;
  readonly #registry: KeyRegistry;

  constructor(options: { session: HsmSession; registry: KeyRegistry; shardId: string }) {
    this.#session = options.session;
    this.#registry = options.registry;
    this.shardId = options.shardId;
  }

  async createKey(walletId: string | null, purpose: KeyPurpose = 'EXECUTOR'): Promise<CreatedKey> {
    if ((purpose === 'GAS_TANK') !== (walletId === null)) {
      throw new SignerProviderError('KEY_NOT_USABLE', 'sólo la cuenta gas tank se crea sin wallet');
    }
    const label = `mtw-${this.shardId}-${crypto.randomUUID()}`;
    const address = publicKeyToAddress(await this.#session.generateSecp256k1(label));
    const shard = await this.#registry.shard();
    if (shard === undefined) throw new SignerProviderError('NOT_READY', 'shard no inicializado');
    const record = await this.#registry.insertKey(this.#registry.db, {
      address,
      walletId,
      purpose,
      kdfVersion: shard.kdfVersion,
      credentialFingerprint: shard.credentialFingerprint,
    });
    await this.#registry.event(this.#registry.db, record.keyRef, 'HSM_LABEL', { label });
    return { keyRef: record.keyRef, address };
  }

  async getAddress(keyRef: string): Promise<Address> {
    const record = await this.#registry.byRef(keyRef);
    if (record === undefined) throw new SignerProviderError('KEY_NOT_FOUND', 'clave desconocida en este shard');
    return record.address;
  }

  async signDigest(keyRef: string, digest: Uint8Array): Promise<EthSignature> {
    if (digest.length !== 32) throw new SignerProviderError('INVALID_DIGEST', 'el digest debe tener 32 bytes');
    const record = await this.#registry.byRef(keyRef);
    if (record === undefined) throw new SignerProviderError('KEY_NOT_FOUND', 'clave desconocida en este shard');
    if (record.status !== 'ACTIVE') throw new SignerProviderError('KEY_NOT_USABLE', `la clave está ${record.status}`);
    const label = (await this.#registry.eventFor(keyRef, 'HSM_LABEL'))?.label;
    if (typeof label !== 'string') throw new SignerProviderError('KEY_UNAVAILABLE', 'sin etiqueta del HSM');
    return toEthSignature(await this.#session.signDigest(label, digest), digest, record.address);
  }

  async health(): Promise<ProviderHealth> {
    const status = await this.#session.health();
    const counts = await this.#registry.counts();
    return {
      provider: this.name,
      shardId: this.shardId,
      ready: status.ok,
      problems: status.ok ? [] : [status.detail ?? 'HSM no disponible'],
      keys: { active: counts.ACTIVE ?? 0, broken: counts.BROKEN ?? 0 },
    };
  }
}
