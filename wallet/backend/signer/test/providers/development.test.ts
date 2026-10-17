// P11.T01 [B-SIG-04]: DevelopmentSignerProvider = SelfHostedSoftwareSignerProvider con guardas. Se niega a arrancar
// fuera de APP_ENV=local, contra un RPC que no es Anvil, contra un Anvil que no forkea Base o con keystores fuera de
// .secrets/signer/; sobre el fork real crea claves en keystores V3 cifrados y nunca escribe la clave en la DB ni en
// los logs.
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../../src/crypto/bytes.ts';
import { keccak256 } from '../../src/crypto/keccak.ts';
import { recoverStrict } from '../../src/crypto/secp256k1.ts';
import { deriveKeystorePassword } from '../../src/keystore/derive-password.ts';
import { decryptKeystore } from '../../src/keystore/v3.ts';
import {
  assertDevelopmentEnvironment,
  DevelopmentGuardError,
  DevelopmentSignerProvider,
} from '../../src/providers/DevelopmentSignerProvider.ts';
import { startAnvil, type AnvilInstance } from '../helpers/anvil.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { captureLogger } from '../helpers/logs.ts';
import { forkUpstreamUrl } from '../helpers/paths.ts';
import { shardWorkspace, type ShardWorkspace } from '../helpers/shard.ts';

let fork: AnvilInstance;
let plain: AnvilInstance;
let wrongChain: AnvilInstance;
let db: TestDatabase;
let ws: ShardWorkspace;

beforeAll(async () => {
  [fork, plain, wrongChain, db] = await Promise.all([
    startAnvil(),
    startAnvil({ fork: false }),
    startAnvil({ chainId: 1 }),
    createTestDatabase(),
  ]);
  ws = shardWorkspace();
});
afterAll(async () => {
  await Promise.all([fork.stop(), plain.stop(), wrongChain.stop()]);
  await db.close();
  ws.cleanup();
});

function guard(overrides: Partial<Parameters<typeof assertDevelopmentEnvironment>[0]> = {}) {
  return {
    appEnv: 'local',
    rpcUrls: [fork.url],
    keystoreDir: ws.keystoreDir,
    credentialFile: ws.credentialFile,
    allowedRoots: [ws.root],
    ...overrides,
  };
}

describe('guardas del provider de desarrollo', () => {
  it('se niega fuera de APP_ENV=local', async () => {
    for (const appEnv of ['staging', 'production']) {
      await expect(assertDevelopmentEnvironment(guard({ appEnv }))).rejects.toThrow(/APP_ENV=local/);
    }
  });

  it('se niega contra un RPC real que no es Anvil (Base mainnet)', async () => {
    await expect(assertDevelopmentEnvironment(guard({ rpcUrls: [forkUpstreamUrl()] }))).rejects.toThrow(/no es Anvil/);
  });

  it('se niega contra un Anvil sin fork', async () => {
    await expect(assertDevelopmentEnvironment(guard({ rpcUrls: [plain.url] }))).rejects.toThrow(/sin forkConfig/);
  });

  it('se niega si alguno de los RPC no es el fork (primario bien, secundario no)', async () => {
    await expect(assertDevelopmentEnvironment(guard({ rpcUrls: [fork.url, plain.url] }))).rejects.toThrow(
      DevelopmentGuardError,
    );
  });

  it('se niega contra un fork con otro chainId', async () => {
    await expect(assertDevelopmentEnvironment(guard({ rpcUrls: [wrongChain.url] }))).rejects.toThrow(/chainId 1/);
  });

  it('se niega con keystores o credencial fuera de .secrets/signer/', async () => {
    await expect(
      assertDevelopmentEnvironment(guard({ allowedRoots: ['/nonexistent/.secrets/signer'] })),
    ).rejects.toThrow(/\.secrets\/signer/);
  });

  it('no abre el provider si una guarda falla (no toca la DB)', async () => {
    const logs = captureLogger();
    await expect(
      DevelopmentSignerProvider.openDevelopment(
        { shardId: 'dev-1', keystoreDir: ws.keystoreDir, credential: ws.credential(), db: db.db, logger: logs.logger },
        guard({ rpcUrls: [plain.url] }),
      ),
    ).rejects.toThrow(DevelopmentGuardError);
    expect(await db.db.selectFrom('signer_shards').selectAll().execute()).toEqual([]);
  });
});

describe('provider de desarrollo sobre el fork', () => {
  it('inicializa el shard, crea S en un keystore V3 0400 y firma digests recuperables a su dirección', async () => {
    const logs = captureLogger();
    const provider = await DevelopmentSignerProvider.openDevelopment(
      { shardId: 'dev-1', keystoreDir: ws.keystoreDir, credential: ws.credential(), db: db.db, logger: logs.logger },
      guard(),
    );
    expect(provider.name).toBe('development');
    expect((await provider.health()).ready).toBe(true);
    const walletId = crypto.randomUUID();
    const { keyRef, address } = await provider.createKey(walletId);
    expect(keyRef).toBe(`dev-1:${address.toLowerCase()}`);
    expect(await provider.getAddress(keyRef)).toBe(address);

    const file = `${ws.keystoreDir}/${address.toLowerCase()}.json`;
    expect(lstatSync(file).mode & 0o777).toBe(0o400);
    expect(statSync(ws.keystoreDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(ws.keystoreDir)).toEqual([`${address.toLowerCase()}.json`]);

    const digest = keccak256(new TextEncoder().encode('safeTxHash de prueba'));
    const signature = await provider.signDigest(keyRef, digest);
    expect(recoverStrict(digest, signature.bytes).toLowerCase()).toBe(address.toLowerCase());

    // La clave (descifrada acá sólo para buscarla) no aparece en la DB ni en los logs.
    const { readFileSync } = await import('node:fs');
    const keystore = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const key = decryptKeystore(keystore, deriveKeystorePassword(ws.credential(), address), address);
    const keyHex = bytesToHex(key).slice(2);
    const dump = await db.admin<{ dump: string }>(
      `SELECT string_agg(t::text, ' ') AS dump FROM (
         SELECT row_to_json(k)::text AS t FROM signer_keys k
         UNION ALL SELECT row_to_json(s)::text FROM signer_shards s
         UNION ALL SELECT row_to_json(e)::text FROM key_events e) x`,
    );
    expect(dump.rows[0]?.dump.toLowerCase()).not.toContain(keyHex);
    expect(dump.rows[0]?.dump).toContain(address.toLowerCase());
    expect(logs.output().toLowerCase()).not.toContain(keyHex);
    expect(logs.output()).toContain('clave creada');
    expect(hexToBytes(`0x${keyHex}`)).toHaveLength(32);
  });

  it('reabrir el shard con otra credencial lo deja no listo y sin firmar', async () => {
    const logs = captureLogger();
    const other = shardWorkspace();
    try {
      const provider = await DevelopmentSignerProvider.openDevelopment(
        {
          shardId: 'dev-1',
          keystoreDir: ws.keystoreDir,
          credential: other.credential(),
          db: db.db,
          logger: logs.logger,
        },
        guard(),
      );
      const health = await provider.health();
      expect(health.ready).toBe(false);
      expect(health.problems.join(' ')).toMatch(/fingerprint distinto/);
      const [key] = await provider.registry.list(['ACTIVE']);
      await expect(provider.signDigest(key!.keyRef, new Uint8Array(32))).rejects.toThrow(/no listo/);
    } finally {
      other.cleanup();
    }
  });
});
