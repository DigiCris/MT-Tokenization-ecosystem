// credentialFingerprint [B-SIG-08]: HMAC-SHA256 de una constante con la credencial del shard. Permite comprobar al
// arrancar que la credencial montada es la que cifró los keystores sin guardar nada derivable de ella en claro.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, type Hex, utf8 } from '../crypto/bytes.ts';
import type { Secret } from '../config/secret.ts';

export const FINGERPRINT_CONSTANT = 'mtw-signer-credential-fingerprint-v1';

export function credentialFingerprint(credential: Secret<Uint8Array>): Hex {
  return bytesToHex(hmac(sha256, credential.reveal(), utf8(FINGERPRINT_CONSTANT)));
}
