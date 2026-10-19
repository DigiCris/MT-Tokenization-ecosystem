// Sobre de prueba de R del seed local (P21.T04, lo llama wallet/scripts/seed-local; sólo desarrollo): sella la R del
// seed con la Password R de prueba usando el módulo crypto propio de Recovery, para importarla en la app como un usuario
// real. Lee todo de variables de entorno y escribe el sobre en un archivo 0600; no imprime ningún secreto.
//   SEED_KEY_HEX  SEED_PASSWORD  PLATFORM_ID  SEED_WALLET_ID  SEED_OUT
import { argon2Sync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { sealRecoveryKey, serializeRecoveryEnvelope } from '../src/crypto/envelope.ts';
import type { Argon2 } from '../src/crypto/kdf.ts';

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
const opened = await sealRecoveryKey(
  key,
  env('SEED_PASSWORD'),
  { platformId: env('PLATFORM_ID'), walletId: env('SEED_WALLET_ID'), keyVersion: 1 },
  nodeArgon2,
);
writeFileSync(env('SEED_OUT'), serializeRecoveryEnvelope(opened.envelope), { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ role: 'R', keyAddress: opened.address })}\n`);
