// Host del signer comprometido (sólo tests de seguridad, P14.TST.a): con el keystore y la credencial de desbloqueo del
// shard se descifra la clave S de una wallet, como lo haría un atacante con root en ese host. Implementación propia
// del formato [B-SIG-08] (HKDF-SHA256 de la credencial → contraseña, scrypt, MAC keccak, AES-128-CTR), independiente
// de la del signer: además cruza el formato del keystore.
import { createDecipheriv, hkdfSync, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, type Address } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { SignerShard } from './signer-shard.ts';

interface KeystoreV3 {
  crypto: {
    cipher: string;
    ciphertext: string;
    cipherparams: { iv: string };
    kdf: string;
    kdfparams: { salt: string; n: number; r: number; p: number; dklen: number };
    mac: string;
  };
}

export function executorAccount(
  shard: Pick<SignerShard, 'keystoreDir' | 'credentialFile'>,
  address: Address,
): PrivateKeyAccount {
  const credential = Buffer.from(readFileSync(shard.credentialFile, 'utf8').trim(), 'hex');
  const password = Buffer.from(
    Buffer.from(hkdfSync('sha256', credential, 'mtw-signer-keystore-v1', address.toLowerCase(), 32)).toString('hex'),
    'utf8',
  );
  const keystore = JSON.parse(
    readFileSync(join(shard.keystoreDir, `${address.toLowerCase()}.json`), 'utf8'),
  ) as KeystoreV3;
  const { kdfparams, ciphertext, cipherparams, mac } = keystore.crypto;
  const derived = scryptSync(password, Buffer.from(kdfparams.salt, 'hex'), kdfparams.dklen, {
    N: kdfparams.n,
    r: kdfparams.r,
    p: kdfparams.p,
    maxmem: 256 * 1024 * 1024,
  });
  const cipherBytes = Buffer.from(ciphertext, 'hex');
  const expected = Buffer.from(keccak256(Buffer.concat([derived.subarray(16, 32), cipherBytes])).slice(2), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(mac, 'hex'))) throw new Error('MAC del keystore inválido');
  const decipher = createDecipheriv('aes-128-ctr', derived.subarray(0, 16), Buffer.from(cipherparams.iv, 'hex'));
  const key = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
  const account = privateKeyToAccount(`0x${key.toString('hex')}`);
  key.fill(0);
  if (account.address.toLowerCase() !== address.toLowerCase()) throw new Error('el keystore no es de esa dirección');
  return account;
}
