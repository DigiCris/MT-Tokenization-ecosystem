// pnpm attestation:public-key
// Clave pública de atestación del signer del entorno [B-SIG-07]/[W-03] para los frontends (P16.T09 la embebe en
// system-contracts.<entorno>.json): JWK Ed25519, `kid` (thumbprint RFC 7638, el que llevan las SignerKeyAttestation) y
// SPKI DER en base64. Se deriva de SIGNER_ATTESTATION_PUBLIC_KEY o de la privada; nunca imprime la privada.
import { createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDotenv } from '../src/config/dotenv.ts';
import { WALLET_ROOT } from '../src/config/env.ts';
import { ed25519Kid, ed25519PrivateKey, ed25519PublicKey } from '../src/crypto/jws.ts';
import { fail, output, run } from '../src/cli/common.ts';

await run(() => {
  const envFile = resolve(WALLET_ROOT, '.env');
  const dotenv =
    (process.env.APP_ENV ?? 'local') === 'local' && existsSync(envFile)
      ? parseDotenv(readFileSync(envFile, 'utf8'))
      : {};
  const value = (name: string) => (process.env[name] ?? dotenv[name]) || undefined;
  const publicBase64 = value('SIGNER_ATTESTATION_PUBLIC_KEY');
  const privateFile = value('SIGNER_ATTESTATION_PRIVATE_KEY_FILE');
  const privateBase64 =
    value('SIGNER_ATTESTATION_PRIVATE_KEY') ??
    (privateFile === undefined ? undefined : readFileSync(privateFile, 'utf8').trim());
  const key =
    publicBase64 !== undefined
      ? ed25519PublicKey(publicBase64)
      : privateBase64 !== undefined
        ? createPublicKey(ed25519PrivateKey(privateBase64))
        : fail('falta SIGNER_ATTESTATION_PUBLIC_KEY (o la privada)');
  const jwk = key.export({ format: 'jwk' }) as { kty: string; crv: string; x: string };
  output({
    kid: ed25519Kid(key),
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    spkiBase64: key.export({ type: 'spki', format: 'der' }).toString('base64'),
  });
});
