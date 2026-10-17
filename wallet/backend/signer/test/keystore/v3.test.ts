// P11.T06 [B-SIG-08]: keystore Ethereum V3 propio (scrypt de @noble/hashes, AES-128-CTR, MAC keccak) contra el vector
// oficial de Web3 Secret Storage y en ida y vuelta, interoperable con `cast wallet` del Foundry fijado en ambos
// sentidos; MAC, dirección y parámetros manipulados se rechazan.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bytesToHex, utf8 } from '../../src/crypto/bytes.ts';
import { generatePrivateKey, privateKeyToAddress } from '../../src/crypto/secp256k1.ts';
import { Secret } from '../../src/config/secret.ts';
import { deriveKeystorePassword, KEYSTORE_PASSWORD_SALT } from '../../src/keystore/derive-password.ts';
import { credentialFingerprint } from '../../src/keystore/fingerprint.ts';
import { decryptKeystore, encryptKeystore, KeystoreError, SCRYPT_PARAMS } from '../../src/keystore/v3.ts';

const dir = mkdtempSync(join(tmpdir(), 'mtw-ks-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Vector scrypt oficial de Web3 Secret Storage (contraseña "testpassword"); se arma en runtime. */
function officialScryptVector() {
  return {
    version: 3,
    id: '3198bc9c-6672-5ab3-d995-4942343ae5b6',
    crypto: {
      cipher: 'aes-128-ctr',
      cipherparams: { iv: '83dbcc02d8ccb40e466191a123791e0e' },
      ciphertext: ['d172bf743a674da9cdad04534d56926e', 'f8358534d458fffccd4e6ad2fbde479c'].join(''),
      kdf: 'scrypt',
      kdfparams: {
        dklen: 32,
        n: 262144,
        p: 8,
        r: 1,
        salt: 'ab0c7876052600dd703518d6fc3fe8984592145b591fc8fb5c6d43190334ba19',
      },
      mac: ['2103ac29920d71da29f15d75b4a16dbe', '95cfd7ff8faea1056c33131d846e3097'].join(''),
    },
  };
}
const OFFICIAL_ADDRESS = '0x008AeEda4D805471dF9b2A5B0f38A0C3bCBA786b';

function cast(args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync('cast', args, { encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`cast ${args.slice(0, 2).join(' ')} falló: ${r.stderr.split('\n')[0]}`);
  return r.stdout;
}

describe('formato V3', () => {
  it('descifra el vector oficial (scrypt n=2^18, r=1, p=8) a su dirección', () => {
    const key = decryptKeystore(officialScryptVector(), utf8('testpassword'), OFFICIAL_ADDRESS);
    expect(privateKeyToAddress(key)).toBe(OFFICIAL_ADDRESS);
  });

  it('con la contraseña equivocada falla por MAC, sin descifrar', () => {
    expect(() => decryptKeystore(officialScryptVector(), utf8('otra'))).toThrow(KeystoreError);
    try {
      decryptKeystore(officialScryptVector(), utf8('otra'));
    } catch (error) {
      expect((error as KeystoreError).problem).toBe('MAC');
    }
  });

  it('ida y vuelta con los parámetros del signer, salt e IV aleatorios', () => {
    const key = generatePrivateKey();
    const password = utf8('a'.repeat(64));
    const a = encryptKeystore(key, password);
    const b = encryptKeystore(key, password);
    expect(a.crypto.kdfparams).toMatchObject({ n: SCRYPT_PARAMS.n, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, dklen: 32 });
    expect(a.crypto.kdfparams.salt).not.toBe(b.crypto.kdfparams.salt);
    expect(a.crypto.cipherparams.iv).not.toBe(b.crypto.cipherparams.iv);
    expect(a.address).toBe(privateKeyToAddress(key).slice(2).toLowerCase());
    expect(bytesToHex(decryptKeystore(a, password, privateKeyToAddress(key)))).toBe(bytesToHex(key));
    expect(JSON.stringify(a)).not.toContain(bytesToHex(key).slice(2));
  });

  it('rechaza MAC, ciphertext o dirección manipulados y parámetros fuera de rango', () => {
    const key = generatePrivateKey();
    const password = utf8('b'.repeat(64));
    const ks = encryptKeystore(key, password);
    const problem = (input: unknown, expected?: `0x${string}`) => {
      try {
        decryptKeystore(input, password, expected);
        return 'OK';
      } catch (error) {
        return error instanceof KeystoreError ? error.problem : 'OTRO';
      }
    };
    const flip = (hex: string) => `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`;
    expect(problem({ ...ks, crypto: { ...ks.crypto, mac: flip(ks.crypto.mac) } })).toBe('MAC');
    expect(problem({ ...ks, crypto: { ...ks.crypto, ciphertext: flip(ks.crypto.ciphertext) } })).toBe('MAC');
    expect(problem(ks, privateKeyToAddress(generatePrivateKey()))).toBe('ADDRESS');
    expect(problem({ ...ks, crypto: { ...ks.crypto, kdfparams: { ...ks.crypto.kdfparams, n: 2 ** 20 } } })).toBe(
      'FORMAT',
    );
    expect(problem({ ...ks, crypto: { ...ks.crypto, kdfparams: { ...ks.crypto.kdfparams, n: 1000 } } })).toBe('FORMAT');
    expect(problem({ ...ks, crypto: { ...ks.crypto, kdf: 'pbkdf2' } })).toBe('FORMAT');
    expect(problem({ ...ks, crypto: { ...ks.crypto, cipher: 'aes-128-cbc' } })).toBe('FORMAT');
    expect(problem({ ...ks, version: 1 })).toBe('FORMAT');
    expect(problem('no es json')).toBe('FORMAT');
  });
});

describe('contraseña derivada y fingerprint de la credencial', () => {
  it('HKDF de la credencial con salt fijo e info = dirección: distinta por clave y por credencial', () => {
    const credential = new Secret(crypto.getRandomValues(new Uint8Array(32)));
    const other = new Secret(crypto.getRandomValues(new Uint8Array(32)));
    const a = privateKeyToAddress(generatePrivateKey());
    const b = privateKeyToAddress(generatePrivateKey());
    const pa = Buffer.from(deriveKeystorePassword(credential, a)).toString();
    expect(pa).toMatch(/^[0-9a-f]{64}$/);
    expect(pa).toBe(Buffer.from(deriveKeystorePassword(credential, a.toLowerCase() as `0x${string}`)).toString());
    expect(pa).not.toBe(Buffer.from(deriveKeystorePassword(credential, b)).toString());
    expect(pa).not.toBe(Buffer.from(deriveKeystorePassword(other, a)).toString());
    expect(KEYSTORE_PASSWORD_SALT).toBe('mtw-signer-keystore-v1');
    expect(credentialFingerprint(credential)).not.toBe(credentialFingerprint(other));
    expect(credentialFingerprint(credential)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('interoperabilidad con cast (Foundry fijado)', () => {
  it('cast descifra los keystores que crea el signer', () => {
    const key = generatePrivateKey();
    const address = privateKeyToAddress(key);
    const credential = new Secret(crypto.getRandomValues(new Uint8Array(32)));
    const password = Buffer.from(deriveKeystorePassword(credential, address)).toString();
    const name = `${address.toLowerCase()}.json`;
    writeFileSync(join(dir, name), JSON.stringify(encryptKeystore(key, utf8(password))), { mode: 0o400 });
    const out = cast(['wallet', 'decrypt-keystore', name, '-k', dir], { CAST_UNSAFE_PASSWORD: password });
    const decrypted = /0x[0-9a-fA-F]{64}/.exec(out)?.[0];
    expect(decrypted?.toLowerCase()).toBe(bytesToHex(key));
  });

  it('el signer descifra los keystores que crea cast', () => {
    const key = generatePrivateKey();
    const password = 'c'.repeat(64);
    // Contraseña y clave de prueba aleatorias: pasarlas por argumentos no expone nada real.
    cast(['wallet', 'import', 'from-cast', '-k', dir, '--private-key', bytesToHex(key), '--unsafe-password', password]);
    const keystore = JSON.parse(readFileSync(join(dir, 'from-cast'), 'utf8')) as unknown;
    const decrypted = decryptKeystore(keystore, utf8(password), privateKeyToAddress(key));
    expect(bytesToHex(decrypted)).toBe(bytesToHex(key));
  });
});
