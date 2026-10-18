// P17.T04 [F-KEY-01..06]: el módulo crypto reproduce los vectores cruzados de contracts/test/vectors/wire (copia en
// test/vectors/): sobres de U y R (Root de Argon2id, K y AuthSecret_U por HKDF, AES-256-GCM con AAD), backup de 17
// palabras con checksum y firmas EIP-712 (RFC 6979, low-s). Además, los vectores estándar de las primitivas (Argon2id
// de referencia, RFC 5869, AES-GCM con AAD; RFC 9106 en test/unit/argon2-protocol.test.ts), sobres alterados y password
// equivocada sin oráculo, y el borrado best-effort.
import { argon2id } from 'hash-wasm';
import { keccak256, toBytes, type TypedDataDefinition } from 'viem';
import { describe, expect, it } from 'vitest';
import backupVectors from '../../test/vectors/wire/backup-words.json';
import eip712Vectors from '../../test/vectors/wire/eip712.json';
import envelopeVectors from '../../test/vectors/wire/envelope.json';
import wordlistText from '../vendor/mtw-wordlist-v1.txt?raw';
import { deriveArgon2id } from '../workers/argon2-protocol.ts';
import { BackupWordsError, backupWordsToKey, keyToBackupWords, splitBackupWords } from './backup-words.ts';
import { fromBase64Url, fromHex, ownBuffer, toBase64Url, toHex, utf8, zeroize } from './bytes.ts';
import {
  EnvelopeError,
  envelopeAad,
  keysForEnvelope,
  openEnvelope,
  parseEnvelope,
  sealKey,
  serializeEnvelope,
  type KeyEnvelope,
} from './envelope.ts';
import { defaultKdfParams, deriveKeys, hkdfBytes, type Argon2 } from './kdf.ts';
import { addressOf, generatePrivateKey, isValidPrivateKey } from './keys.ts';
import { signDigest, signTypedDataWithKey, withKey } from './sign.ts';
import { keyAcceptance, keyRestore, platformDomain, walletCreationAuthorization } from './typed-data.ts';
import { parseWordlist } from './wordlist.ts';

const wordlist = parseWordlist(wordlistText);
const argon2: Argon2 = (input) => deriveArgon2id(input);
const testKey = (label: string) => toBytes(keccak256(toBytes(label)));
const ALTERED = 'no se pudo abrir el sobre: password incorrecta o sobre alterado';

interface EnvelopeVector {
  keyLabel: string;
  password: string;
  rootHex: `0x${string}`;
  encryptionKeyHex: `0x${string}`;
  authSecretHex?: `0x${string}`;
  aad: string;
  envelope: KeyEnvelope;
}

const envelopes = (envelopeVectors as unknown as { envelopes: EnvelopeVector[] }).envelopes;
const firstEnvelope = () => {
  const vector = envelopes[0];
  if (!vector) throw new Error('faltan vectores de sobres');
  return { vector, envelope: parseEnvelope(vector.envelope) };
};

describe('vectores estándar de las primitivas', () => {
  it('Argon2id: vector de la implementación de referencia, v1.3 (la que corre en el worker)', async () => {
    const tag = await argon2id({
      password: 'password',
      salt: 'somesalt',
      iterations: 2,
      memorySize: 65_536,
      parallelism: 1,
      hashLength: 32,
      outputType: 'hex',
    });
    expect(tag).toBe('09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7');
  });

  it('HKDF-SHA256 de WebCrypto: RFC 5869, casos 1 y 3', async () => {
    const hkdf = async (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) => {
      const key = await crypto.subtle.importKey('raw', ownBuffer(ikm), 'HKDF', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: ownBuffer(salt), info: ownBuffer(info) },
        key,
        length * 8,
      );
      return toHex(new Uint8Array(bits));
    };
    const ikm = new Uint8Array(22).fill(0x0b);
    expect(await hkdf(ikm, fromHex('0x000102030405060708090a0b0c'), fromHex('0xf0f1f2f3f4f5f6f7f8f9'), 42)).toBe(
      '0x3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
    expect(await hkdf(ikm, new Uint8Array(), new Uint8Array(), 42)).toBe(
      '0x8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
    );
  });

  it('AES-256-GCM con AAD de WebCrypto: caso 16 de la especificación de GCM; un AAD distinto no descifra', async () => {
    const key = await crypto.subtle.importKey(
      'raw',
      ownBuffer(fromHex('0xfeffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308')),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );
    const iv = ownBuffer(fromHex('0xcafebabefacedbaddecaf888'));
    const aad = ownBuffer(fromHex('0xfeedfacedeadbeeffeedfacedeadbeefabaddad2'));
    const plaintext = fromHex(
      '0xd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39',
    );
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
        key,
        ownBuffer(plaintext),
      ),
    );
    expect(toHex(sealed)).toBe(
      '0x522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662' +
        '76fc6ece0f4e1768cddf8853bb2d551b',
    );
    const otherAad = ownBuffer(aad);
    otherAad[0] = (otherAad[0] ?? 0) ^ 1;
    await expect(
      crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: otherAad, tagLength: 128 }, key, ownBuffer(sealed)),
    ).rejects.toThrow();
  });
});

describe('sobres [F-KEY-03]/[F-KEY-04]', () => {
  it.each(envelopes.map((v) => [v.envelope.role, v] as const))(
    '%s: Root, K, AuthSecret y AAD del vector',
    async (_role, v) => {
      const root = await argon2({
        password: utf8(v.password),
        salt: fromBase64Url(v.envelope.kdf.salt),
        memoryKiB: v.envelope.kdf.memoryKiB,
        iterations: v.envelope.kdf.iterations,
        parallelism: v.envelope.kdf.parallelism,
        outputLength: 32,
      });
      expect(toHex(root)).toBe(v.rootHex);
      expect(toHex(await hkdfBytes(root, `${v.envelope.role}-encryption-v1`))).toBe(v.encryptionKeyHex);
      if (v.authSecretHex) expect(toHex(await hkdfBytes(root, 'U-auth-v1'))).toBe(v.authSecretHex);
      expect(envelopeAad(v.envelope)).toBe(v.aad);
    },
  );

  it.each(envelopes.map((v) => [v.envelope.role, v] as const))(
    '%s: con la password se abre y devuelve la clave; sellar con el mismo nonce da el mismo sobre',
    async (_role, v) => {
      const envelope = parseEnvelope(v.envelope);
      const keys = await keysForEnvelope(envelope, v.password, argon2);
      if (v.authSecretHex) expect(toHex(keys.authSecret ?? new Uint8Array())).toBe(v.authSecretHex);
      else expect(keys.authSecret).toBeNull();
      const key = await openEnvelope(envelope, keys.encryptionKey);
      expect(toHex(key)).toBe(toHex(testKey(v.keyLabel)));
      const sealed = await sealKey(key, keys.encryptionKey, envelope, envelope.kdf, {
        nonce: fromBase64Url(envelope.cipher.nonce),
        createdAt: envelope.createdAt,
      });
      expect(sealed).toEqual(envelope);
      expect(JSON.parse(serializeEnvelope(sealed))).toEqual(v.envelope);
      expect(Object.keys(JSON.parse(serializeEnvelope(sealed)) as object)).toEqual(Object.keys(v.envelope));
    },
  );

  it('AAD, ciphertext o nonce alterados y password equivocada fallan igual (sin oráculo)', async () => {
    const { vector, envelope } = firstEnvelope();
    const { encryptionKey } = await keysForEnvelope(envelope, vector.password, argon2);
    const flipped = fromBase64Url(envelope.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    const otherNonce = fromBase64Url(envelope.cipher.nonce);
    otherNonce[0] = (otherNonce[0] ?? 0) ^ 1;
    const variants: KeyEnvelope[] = [
      { ...envelope, walletId: '00000000-0000-4000-8000-000000000000' },
      { ...envelope, keyVersion: envelope.keyVersion + 1 },
      { ...envelope, platformId: 'otra-plataforma' },
      { ...envelope, ciphertext: toBase64Url(flipped) },
      { ...envelope, cipher: { ...envelope.cipher, nonce: toBase64Url(otherNonce) } },
    ];
    for (const variant of variants) await expect(openEnvelope(variant, encryptionKey)).rejects.toThrow(ALTERED);
    const wrong = await keysForEnvelope(envelope, 'una password que no es la del sobre', argon2);
    await expect(openEnvelope(envelope, wrong.encryptionKey)).rejects.toThrow(ALTERED);
  });

  it('rechaza sobres mal formados o con parámetros fuera de rango', () => {
    const base = firstEnvelope().vector.envelope;
    const broken: unknown[] = [
      null,
      [],
      { ...base, format: 'otro' },
      { ...base, formatVersion: 2 },
      { ...base, platformId: 'Con Mayúsculas' },
      { ...base, chainId: 1 },
      { ...base, walletId: 'no-es-un-uuid' },
      { ...base, role: 'S' },
      { ...base, keyAddress: '0x1234' },
      { ...base, keyVersion: 0 },
      { ...base, kdf: { ...base.kdf, alg: 'scrypt' } },
      { ...base, kdf: { ...base.kdf, salt: toBase64Url(new Uint8Array(32)) } },
      { ...base, cipher: { ...base.cipher, alg: 'AES-128-GCM' } },
      { ...base, cipher: { ...base.cipher, nonce: toBase64Url(new Uint8Array(16)) } },
      { ...base, ciphertext: toBase64Url(new Uint8Array(32)) },
      { ...base, createdAt: 'ayer' },
    ];
    for (const value of broken) expect(() => parseEnvelope(value), JSON.stringify(value)).toThrow(EnvelopeError);
    // Parámetros de Argon2id que agotarían el dispositivo: el sobre se rechaza antes de derivar nada.
    expect(() => parseEnvelope({ ...base, kdf: { ...base.kdf, memoryKiB: 4 * 1024 * 1024 } })).toThrow(RangeError);
    expect(() => parseEnvelope({ ...base, kdf: { ...base.kdf, salt: 'AAAA' } })).toThrow(RangeError);
  });

  it('no sella una clave que no corresponde a la dirección del sobre ni abre una clave ajena', async () => {
    const { vector, envelope } = firstEnvelope();
    const { encryptionKey } = await keysForEnvelope(envelope, vector.password, argon2);
    await expect(sealKey(testKey('otra-clave'), encryptionKey, envelope, envelope.kdf)).rejects.toThrow(EnvelopeError);
    // Un sobre bien cifrado pero con la dirección de otra clave en los metadatos no se acepta.
    const other = testKey('otra-clave');
    const forged = await sealKey(other, encryptionKey, { ...envelope, keyAddress: addressOf(other) }, envelope.kdf);
    await expect(openEnvelope({ ...forged, keyAddress: envelope.keyAddress }, encryptionKey)).rejects.toThrow(ALTERED);
    // Cifrado con el AAD correcto pero con otra clave adentro (sólo lo arma quien tiene K): la dirección no coincide.
    const nonce = ownBuffer(fromBase64Url(envelope.cipher.nonce));
    const swapped = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: ownBuffer(utf8(envelopeAad(envelope))), tagLength: 128 },
      encryptionKey,
      ownBuffer(other),
    );
    await expect(
      openEnvelope({ ...envelope, ciphertext: toBase64Url(new Uint8Array(swapped)) }, encryptionKey),
    ).rejects.toThrow('la clave del sobre no corresponde a su dirección');
  });

  it('sella con nonce nuevo en cada cifrado y fecha sin milisegundos', async () => {
    const { vector, envelope } = firstEnvelope();
    const { encryptionKey } = await keysForEnvelope(envelope, vector.password, argon2);
    const key = testKey(vector.keyLabel);
    const a = await sealKey(key, encryptionKey, envelope, envelope.kdf);
    const b = await sealKey(key, encryptionKey, envelope, envelope.kdf);
    expect(a.cipher.nonce).not.toBe(b.cipher.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(toHex(await openEnvelope(a, encryptionKey))).toBe(toHex(key));
  });
});

describe('borrado best-effort [F-KEY-05]', () => {
  it('deriveKeys borra Root y la password en bytes; K no es exportable', async () => {
    const { vector, envelope } = firstEnvelope();
    const seen: Uint8Array[] = [];
    const spy: Argon2 = async (input) => {
      const root = await argon2(input);
      seen.push(input.password, root);
      return root;
    };
    const keys = await deriveKeys(vector.password, 'U', envelope.kdf, fromBase64Url(envelope.kdf.salt), spy);
    expect(seen).toHaveLength(2);
    for (const buffer of seen) expect(buffer.every((b) => b === 0)).toBe(true);
    expect(keys.encryptionKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', keys.encryptionKey)).rejects.toThrow();
  });

  it('zeroize saltea los buffers ya transferidos a un worker (detached) y borra el resto', () => {
    const transferred = Uint8Array.of(1, 2, 3);
    structuredClone(transferred, { transfer: [transferred.buffer] });
    expect(transferred.buffer.detached).toBe(true);
    const kept = Uint8Array.of(4, 5, 6);
    expect(() => {
      zeroize(transferred, undefined, kept);
    }).not.toThrow();
    expect([...kept]).toEqual([0, 0, 0]);
  });

  it('withKey descifra U sólo durante la firma y la borra después, también si la firma falla', async () => {
    const { vector, envelope } = firstEnvelope();
    const { encryptionKey } = await keysForEnvelope(envelope, vector.password, argon2);
    let seen: Uint8Array = new Uint8Array();
    await expect(
      withKey(envelope, encryptionKey, (key) => {
        seen = key;
        throw new Error('falla la firma');
      }),
    ).rejects.toThrow('falla la firma');
    expect(seen).toHaveLength(32);
    expect(seen.every((b) => b === 0)).toBe(true);
  });
});

describe('backup de 17 palabras [F-KEY-06]', () => {
  const backups = (
    backupVectors as unknown as {
      backups: { role: 'U' | 'R'; keyLabel: string; checksum12: number; indices: number[]; words: string[] }[];
    }
  ).backups;
  const first = () => {
    const backup = backups[0];
    if (!backup) throw new Error('faltan vectores de backup');
    return backup;
  };

  it.each(backups.map((b) => [b.role, b] as const))('%s: clave ↔ palabras del vector', async (_role, b) => {
    const key = testKey(b.keyLabel);
    expect(await keyToBackupWords(b.role, key, wordlist)).toEqual(b.words);
    expect(b.words.map((w) => wordlist.index.get(w))).toEqual(b.indices);
    expect((b.indices[16] ?? 0) & 0xfff).toBe(b.checksum12);
    expect(toHex(await backupWordsToKey(b.role, b.words, wordlist))).toBe(toHex(key));
    expect(
      toHex(await backupWordsToKey(b.role, splitBackupWords(`  ${b.words.join('  ').toUpperCase()}\n`), wordlist)),
    ).toBe(toHex(key));
  });

  it('un error de tipeo, una palabra fuera de la lista, el rol equivocado u otra versión se detectan', async () => {
    const b = first();
    const typo = [...b.words];
    typo[3] = wordlist.words[((b.indices[3] ?? 0) + 1) & 0xffff] ?? '';
    await expect(backupWordsToKey(b.role, typo, wordlist)).rejects.toThrow('checksum');
    const unknown = [...b.words];
    unknown[5] = 'palabrainexistente';
    unknown[9] = 'otrainexistente';
    await expect(backupWordsToKey(b.role, unknown, wordlist)).rejects.toMatchObject({ positions: [5, 9] });
    await expect(backupWordsToKey(b.role === 'U' ? 'R' : 'U', b.words, wordlist)).rejects.toBeInstanceOf(
      BackupWordsError,
    );
    const otherVersion = [...b.words];
    otherVersion[16] = wordlist.words[(2 << 12) | b.checksum12] ?? '';
    await expect(backupWordsToKey(b.role, otherVersion, wordlist)).rejects.toMatchObject({ positions: [16] });
    await expect(backupWordsToKey(b.role, b.words.slice(0, 16), wordlist)).rejects.toThrow('17');
  });

  it('no convierte en palabras algo que no es una clave válida', async () => {
    await expect(keyToBackupWords('U', new Uint8Array(32), wordlist)).rejects.toBeInstanceOf(BackupWordsError);
  });
});

describe('firmas EIP-712 (RFC 6979, low-s)', () => {
  const eip712 = eip712Vectors as unknown as {
    domain: TypedDataDefinition['domain'];
    types: {
      primaryType: string;
      type: string;
      digest: `0x${string}`;
      signer: string;
      signature: `0x${string}`;
      message: Record<string, unknown>;
    }[];
  };
  const keys = new Map(
    ['mtw-user-key', 'mtw-recovery-key', 'mtw-vector-new-user-key'].map((label) => {
      const key = testKey(label);
      return [addressOf(key), key] as const;
    }),
  );

  /** "Nombre(tipo campo,tipo campo)" → tipos de viem; los uint van como bigint. */
  function typedData(entry: (typeof eip712.types)[number]): TypedDataDefinition {
    const [, name = '', body = ''] = /^(\w+)\((.*)\)$/.exec(entry.type) ?? [];
    const fields = body.split(',').map((field) => {
      const [type = '', fieldName = ''] = field.split(' ');
      return { name: fieldName, type };
    });
    const message = Object.fromEntries(
      fields.map(({ name: field, type }) => {
        const value = entry.message[field];
        return [field, type.startsWith('uint') ? BigInt(value as string | number) : value];
      }),
    );
    return {
      domain: eip712.domain,
      types: { [name]: fields },
      primaryType: name,
      message,
    } as unknown as TypedDataDefinition;
  }

  it.each(eip712.types.map((t) => [t.primaryType, t] as const))('%s: digest y firma del vector', (_name, entry) => {
    const key = keys.get(entry.signer as `0x${string}`);
    if (!key) throw new Error(`falta la clave de ${entry.signer}`);
    expect(signTypedDataWithKey(key, typedData(entry))).toBe(entry.signature);
    expect(signDigest(fromHex(entry.digest), key)).toBe(entry.signature);
    // low-s: s ≤ n/2.
    const s = BigInt(`0x${entry.signature.slice(66, 130)}`);
    expect(s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true);
  });

  it('los builders tipados de la plataforma dan los digests de los vectores', () => {
    const factory = (eip712.domain as { verifyingContract: `0x${string}` }).verifyingContract;
    expect(platformDomain(factory)).toEqual(eip712.domain);
    const byType = new Map(eip712.types.map((t) => [t.primaryType, t]));
    const message = (name: string) => byType.get(name)?.message ?? {};
    const creation = message('WalletCreationAuthorization') as Parameters<typeof walletCreationAuthorization>[1] & {
      saltNonce: string;
    };
    const acceptance = message('KeyAcceptance') as { walletId: string; newKey: `0x${string}`; nonce: `0x${string}` };
    const restore = message('KeyRestore') as Parameters<typeof keyRestore>[1];
    const user = testKey('mtw-user-key');
    const newUser = testKey('mtw-vector-new-user-key');
    expect(
      signTypedDataWithKey(
        user,
        walletCreationAuthorization(factory, { ...creation, saltNonce: BigInt(creation.saltNonce) }),
      ),
    ).toBe(byType.get('WalletCreationAuthorization')?.signature);
    expect(signTypedDataWithKey(newUser, keyAcceptance(factory, { ...acceptance, role: 'U' }))).toBe(
      byType.get('KeyAcceptance')?.signature,
    );
    expect(signTypedDataWithKey(user, keyRestore(factory, restore))).toBe(byType.get('KeyRestore')?.signature);
  });

  it('rechaza digests que no son de 32 bytes y claves inválidas', () => {
    const key = testKey('mtw-user-key');
    expect(() => signDigest(new Uint8Array(31), key)).toThrow(TypeError);
    expect(() => signDigest(new Uint8Array(32), new Uint8Array(32))).toThrow(TypeError);
  });
});

describe('claves y bytes [F-KEY-01]', () => {
  it('genera escalares válidos y descarta los inválidos (0 y ≥ n)', () => {
    const invalid = [new Uint8Array(32), new Uint8Array(32).fill(0xff)];
    const valid = testKey('mtw-user-key');
    let call = 0;
    const key = generatePrivateKey(() => invalid[call++] ?? new Uint8Array(valid));
    expect(call).toBe(3);
    expect(toHex(key)).toBe(toHex(valid));
    expect(invalid.every((buffer) => buffer.every((b) => b === 0))).toBe(true);
    const fresh = generatePrivateKey();
    expect(isValidPrivateKey(fresh)).toBe(true);
    expect(toHex(fresh)).not.toBe(toHex(generatePrivateKey()));
    expect(() => addressOf(new Uint8Array(32))).toThrow(TypeError);
  });

  it('hex y base64url estrictos; parámetros por defecto del sobre', () => {
    expect(() => fromHex('0x0')).toThrow(TypeError);
    expect(() => fromHex('abcd')).toThrow(TypeError);
    expect(toHex(fromHex('0xABcd'))).toBe('0xabcd');
    expect(() => fromBase64Url('AA==')).toThrow();
    expect(defaultKdfParams('c2FsdA')).toEqual({
      alg: 'argon2id',
      version: 19,
      memoryKiB: 65_536,
      iterations: 3,
      parallelism: 4,
      salt: 'c2FsdA',
    });
  });
});
