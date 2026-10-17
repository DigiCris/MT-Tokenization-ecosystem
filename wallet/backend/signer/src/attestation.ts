// SignerKeyAttestation [B-SIG-07]/[W-03]: al crear S el signer firma `{walletId, shardId, executor, chainId, issuedAt}`
// con su clave de atestación Ed25519 (una por entorno; la pública la embeben los frontends). La Wallet la verifica
// antes de que U firme la autorización de creación: un backend comprometido no puede sustituir S por una clave suya.
import type { KeyObject } from 'node:crypto';
import type { Address } from './crypto/keccak.ts';
import { ed25519Kid, signJws } from './crypto/jws.ts';
import type { Secret } from './config/secret.ts';

export class KeyAttestor {
  readonly kid: string;
  readonly #privateKey: Secret<KeyObject>;
  readonly #shardId: string;
  readonly #chainId: number;

  constructor(options: { privateKey: Secret<KeyObject>; publicKey: KeyObject; shardId: string; chainId: number }) {
    this.#privateKey = options.privateKey;
    this.kid = ed25519Kid(options.publicKey);
    this.#shardId = options.shardId;
    this.#chainId = options.chainId;
  }

  issue(input: { walletId: string; executor: Address; issuedAt?: number }): string {
    return signJws(
      {
        walletId: input.walletId,
        shardId: this.#shardId,
        executor: input.executor,
        chainId: this.#chainId,
        issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1000),
      },
      this.#privateKey.reveal(),
      this.kid,
    );
  }
}
