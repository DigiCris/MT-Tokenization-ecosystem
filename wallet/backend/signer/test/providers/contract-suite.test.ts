// P11.T07 [B-SIG-04]: suite de contrato común a todos los SignerProvider (la corren DevelopmentSignerProvider y
// SelfHostedSoftwareSignerProvider; HardwareSignerProvider la correrá contra un HSM real cuando exista): claves nuevas
// con dirección consistente, firma recuperable a esa dirección, low-s, `v` ∈ {27, 28} coherente con yParity,
// determinística, digests inválidos y claves desconocidas rechazados, y la cuenta gas tank sólo sin wallet.
// Además, el adaptador de firmas de un HSM (s alto, sin bit de recuperación) contra firmas ECDSA reales.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256 } from '../../src/crypto/keccak.ts';
import { generatePrivateKey, privateKeyToAddress, recoverStrict } from '../../src/crypto/secp256k1.ts';
import { credentialFingerprint } from '../../src/keystore/fingerprint.ts';
import { DevelopmentSignerProvider } from '../../src/providers/DevelopmentSignerProvider.ts';
import { toEthSignature } from '../../src/providers/HardwareSignerProvider.ts';
import { SelfHostedSoftwareSignerProvider } from '../../src/providers/SelfHostedSoftwareSignerProvider.ts';
import { SignerProviderError, type SignerProvider } from '../../src/providers/SignerProvider.ts';
import { startAnvil, type AnvilInstance } from '../helpers/anvil.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { captureLogger } from '../helpers/logs.ts';
import { shardWorkspace, type ShardWorkspace } from '../helpers/shard.ts';

const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const logs = captureLogger();
let anvil: AnvilInstance;
const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  anvil = await startAnvil();
});
afterAll(async () => {
  for (const c of cleanups) await c();
  await anvil.stop();
});

async function workspace(shardId: string): Promise<{ db: TestDatabase; ws: ShardWorkspace }> {
  const db = await createTestDatabase();
  const ws = shardWorkspace(shardId);
  cleanups.push(
    () => db.close(),
    () => {
      ws.cleanup();
    },
  );
  return { db, ws };
}

const factories: [string, () => Promise<SignerProvider>][] = [
  [
    'DevelopmentSignerProvider',
    async () => {
      const { db, ws } = await workspace('dev-1');
      return DevelopmentSignerProvider.openDevelopment(
        { shardId: 'dev-1', keystoreDir: ws.keystoreDir, credential: ws.credential(), db: db.db, logger: logs.logger },
        {
          appEnv: 'local',
          rpcUrls: [anvil.url],
          keystoreDir: ws.keystoreDir,
          credentialFile: ws.credentialFile,
          allowedRoots: [ws.root],
        },
      );
    },
  ],
  [
    'SelfHostedSoftwareSignerProvider',
    async () => {
      const { db, ws } = await workspace('shard-x');
      const opts = {
        shardId: 'shard-x',
        keystoreDir: ws.keystoreDir,
        credential: ws.credential(),
        db: db.db,
        logger: logs.logger,
      };
      const first = await SelfHostedSoftwareSignerProvider.open(opts);
      await first.registry.initShard({
        provider: 'selfhosted',
        credentialFingerprint: credentialFingerprint(ws.credential()),
      });
      return SelfHostedSoftwareSignerProvider.open(opts);
    },
  ],
];

describe.each(factories)('suite de contrato: %s', (_name, factory) => {
  let provider: SignerProvider;
  beforeAll(async () => {
    provider = await factory();
  });

  it('está listo y crea claves distintas con dirección consistente', async () => {
    expect((await provider.health()).ready).toBe(true);
    const a = await provider.createKey(crypto.randomUUID());
    const b = await provider.createKey(crypto.randomUUID());
    expect(a.address).not.toBe(b.address);
    expect(await provider.getAddress(a.keyRef)).toBe(a.address);
    expect(a.keyRef).toBe(`${provider.shardId}:${a.address.toLowerCase()}`);
  });

  it('firma recuperable a la dirección, low-s, v coherente con yParity y determinística', async () => {
    const { keyRef, address } = await provider.createKey(crypto.randomUUID());
    for (let i = 0; i < 16; i++) {
      const digest = keccak256(new TextEncoder().encode(`digest ${i}`));
      const sig = await provider.signDigest(keyRef, digest);
      expect(recoverStrict(digest, sig.bytes)).toBe(address);
      expect(BigInt(sig.s) <= HALF_N).toBe(true);
      expect(sig.v).toBe(27 + sig.yParity);
      expect(sig.bytes).toBe(`${sig.r}${sig.s.slice(2)}${sig.v.toString(16)}`);
      expect((await provider.signDigest(keyRef, digest)).bytes).toBe(sig.bytes);
    }
  });

  it('rechaza digests de longitud distinta de 32 y claves desconocidas', async () => {
    const { keyRef } = await provider.createKey(crypto.randomUUID());
    await expect(provider.signDigest(keyRef, new Uint8Array(31))).rejects.toMatchObject({ code: 'INVALID_DIGEST' });
    await expect(
      provider.signDigest(`${provider.shardId}:0x${'00'.repeat(20)}`, new Uint8Array(32)),
    ).rejects.toMatchObject({
      code: 'KEY_NOT_FOUND',
    });
    await expect(provider.getAddress('otro:0x00')).rejects.toBeInstanceOf(SignerProviderError);
  });

  it('la cuenta gas tank se crea sin wallet; una S siempre con wallet', async () => {
    await expect(provider.createKey(null, 'EXECUTOR')).rejects.toMatchObject({ code: 'KEY_NOT_USABLE' });
    await expect(provider.createKey(crypto.randomUUID(), 'GAS_TANK')).rejects.toMatchObject({ code: 'KEY_NOT_USABLE' });
    const gasTank = await provider.createKey(null, 'GAS_TANK');
    expect(await provider.getAddress(gasTank.keyRef)).toBe(gasTank.address);
  });
});

describe('adaptador de firmas de HSM (HardwareSignerProvider)', () => {
  it('normaliza s alto, calcula v y rechaza firmas de otra clave', () => {
    const key = generatePrivateKey();
    const address = privateKeyToAddress(key);
    let highS = 0;
    for (let i = 0; i < 32; i++) {
      const digest = keccak256(new TextEncoder().encode(`hsm ${i}`));
      // ECDSA real sin normalizar (como la devuelve un HSM PKCS#11): s puede caer en la mitad alta.
      const rs = secp256k1.sign(digest, key, { prehash: false, lowS: false, format: 'compact' });
      if (BigInt(`0x${Buffer.from(rs.subarray(32)).toString('hex')}`) > HALF_N) highS++;
      const sig = toEthSignature(rs, digest, address);
      expect(BigInt(sig.s) <= HALF_N).toBe(true);
      expect(recoverStrict(digest, sig.bytes)).toBe(address);
      expect(() => toEthSignature(rs, digest, privateKeyToAddress(generatePrivateKey()))).toThrow(/no corresponde/);
    }
    expect(highS).toBeGreaterThan(0);
    expect(() => toEthSignature(new Uint8Array(63), new Uint8Array(32), address)).toThrow(/longitud/);
    expect(() => toEthSignature(new Uint8Array(64), new Uint8Array(32), address)).toThrow(/fuera de rango/);
  });
});
