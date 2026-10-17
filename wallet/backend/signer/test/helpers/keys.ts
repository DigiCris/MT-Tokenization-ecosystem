// Claves Ed25519 de prueba en el formato de `pnpm secrets:local` (privada PKCS#8 DER y pública SPKI DER en base64).
import { generateKeyPairSync, type KeyObject } from 'node:crypto';

export interface TestEdKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  privateBase64: string;
  publicBase64: string;
}

export function testEdKey(): TestEdKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKey,
    privateBase64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}
