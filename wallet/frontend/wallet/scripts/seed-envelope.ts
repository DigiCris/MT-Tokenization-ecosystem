// Sobre de prueba de U del seed local (P21.T04, lo llama wallet/scripts/seed-local; sólo desarrollo): sella la U del
// seed con la Password U de prueba usando el mismo módulo crypto de la app (Argon2id + HKDF + AES-GCM con AAD), para
// importarla en la app como un usuario real. Lee todo de variables de entorno y escribe el sobre en un archivo 0600;
// no imprime ningún secreto.
//   SEED_KEY_HEX  SEED_PASSWORD  PLATFORM_ID  SEED_WALLET_ID  SEED_OUT
import { argon2Sync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { sealKey, serializeEnvelope } from '../src/crypto/envelope.ts';
import { defaultKdfParams, deriveKeys, type Argon2 } from '../src/crypto/kdf.ts';
import { addressOf } from '../src/crypto/keys.ts';

const nodeArgon2: Argon2 = (input) =>
  Promise.resolve(
    new Uint8Array(
      argon2Sync('argon2id', {
        message: Buffer.from(input.password),
        nonce: Buffer.from(input.salt),
        parallelism: input.parallelism,
        tagLength: input.outputLength,
        memory: input.memoryKiB,
        passes: input.iterations,
      }),
    ),
  );

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`falta ${name}`);
  return value;
};

const key = Uint8Array.from(Buffer.from(env('SEED_KEY_HEX').replace(/^0x/, ''), 'hex'));
const salt = randomBytes(16);
const kdf = defaultKdfParams(salt.toString('base64url'));
const keys = await deriveKeys(env('SEED_PASSWORD'), 'U', kdf, salt, nodeArgon2);
const envelope = await sealKey(
  key,
  keys.encryptionKey,
  {
    platformId: env('PLATFORM_ID'),
    chainId: 8453,
    walletId: env('SEED_WALLET_ID'),
    role: 'U',
    keyAddress: addressOf(key),
    keyVersion: 1,
  },
  kdf,
);
writeFileSync(env('SEED_OUT'), serializeEnvelope(envelope), { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ role: 'U', keyAddress: envelope.keyAddress })}\n`);
