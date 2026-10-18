// P11.T08 [B-SIG-09] y P11.T02/TST (backend↔signer por mTLS): asignación de wallet a shard por hash estable sobre los
// shards activos, GUARDADA en signer_keys (no se recalcula si cambian los shards); la S la crea el shard asignado
// (proceso real del signer) y se guarda con su SignerKeyAttestation; un certificado de cliente de otra CA no llega.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactVerify } from 'jose';
import { PasswordHasher } from '../../src/auth/password.ts';
import { SignerClient, SignerClientError } from '../../src/signer-client/client.ts';
import { assignShard, SignerKeyService } from '../../src/signer-client/sharding.ts';
import { testConfig } from '../helpers/config.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { startAnvil, type AnvilInstance } from '../helpers/fork.ts';
import {
  createPki,
  edKey,
  startSignerShard,
  vectorSystem,
  writePolicySnapshot,
  type Pki,
  type SignerShard,
} from '../helpers/signer-shard.ts';
import { readFileSync } from 'node:fs';

const shards3 = [
  { id: 'dev-1', url: 'https://a', active: true },
  { id: 'dev-2', url: 'https://b', active: true },
  { id: 'dev-3', url: 'https://c', active: true },
];

describe('assignShard (hash estable)', () => {
  it('es determinística, independiente del orden y del formato del uuid', () => {
    const walletId = crypto.randomUUID();
    const a = assignShard(walletId, shards3);
    expect(assignShard(walletId, [...shards3].reverse())).toBe(a);
    expect(assignShard(walletId.toUpperCase(), shards3)).toBe(a);
  });

  it('reparte de forma pareja y sólo entre los shards activos', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 3_000; i++) {
      const id = assignShard(crypto.randomUUID(), shards3);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const s of shards3) expect(counts.get(s.id)! / 3_000).toBeGreaterThan(0.28);
    const withInactive = [...shards3.slice(0, 2), { ...shards3[2]!, active: false }];
    for (let i = 0; i < 200; i++) expect(assignShard(crypto.randomUUID(), withInactive)).not.toBe('dev-3');
    expect(() =>
      assignShard(
        crypto.randomUUID(),
        shards3.map((s) => ({ ...s, active: false })),
      ),
    ).toThrow(/activos/);
  });
});

let anvil: AnvilInstance;
let pki: Pki;
let db: TestDatabase;
let dev1: SignerShard;
let dev2: SignerShard;
let dir: string;
const keys = { attestation: edKey(), policy: edKey(), issuer: edKey() };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mtw-sharding-'));
  [anvil, db] = await Promise.all([startAnvil(), createTestDatabase()]);
  pki = createPki();
  const snapshotPath = writePolicySnapshot(dir, keys.policy, vectorSystem());
  const started = await Promise.all(
    ['dev-1', 'dev-2'].map((shardId) => startSignerShard({ shardId, anvilUrl: anvil.url, pki, keys, snapshotPath })),
  );
  dev1 = started[0]!;
  dev2 = started[1]!;
});
afterAll(async () => {
  // Si el beforeAll falló a mitad de camino, algo puede no existir.
  const maybe = <T>(value: T) => value as T | undefined;
  await Promise.all([maybe(dev1)?.stop(), maybe(dev2)?.stop()]);
  await maybe(db)?.close();
  await maybe(anvil)?.stop();
  maybe(pki)?.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

async function newWallet(): Promise<string> {
  const config = testConfig();
  const { hash, pepperVersion } = await new PasswordHasher(config.secrets.passwordPeppers).hash(
    'una contraseña de prueba larga',
  );
  const user = await db.app
    .insertInto('users')
    .values({
      platform_id: config.platformId,
      email: `${crypto.randomUUID()}@test.invalid`,
      password_hash: hash,
      pepper_version: pepperVersion,
      email_verified_at: sql`now()`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const wallet = await db.app
    .insertInto('wallets')
    .values({ user_id: user.id, platform_id: config.platformId, chain_id: 8453, status: 'CREATING' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return wallet.id;
}

describe('backend ↔ shards reales por mTLS', () => {
  it('cada wallet nueva va a su shard por hash; la S y su atestación quedan guardadas', async () => {
    const endpoints = [
      { id: 'dev-1', url: dev1.url, active: true },
      { id: 'dev-2', url: dev2.url, active: true },
    ];
    const service = new SignerKeyService({
      db: db.app,
      shards: endpoints,
      clients: new Map([
        ['dev-1', dev1.client],
        ['dev-2', dev2.client],
      ]),
    });
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const walletId = await newWallet();
      const expected = assignShard(walletId, endpoints);
      const key = await service.ensureExecutor(walletId);
      expect(key.shardId).toBe(expected);
      seen.add(key.shardId);
      // Idempotente: misma S en un segundo pedido.
      expect((await service.ensureExecutor(walletId)).address).toBe(key.address);
      const { payload } = await compactVerify(key.attestation!, keys.attestation.publicKey);
      expect(JSON.parse(Buffer.from(payload).toString('utf8'))).toMatchObject({
        walletId,
        shardId: expected,
        executor: key.address,
      });
    }
    expect(seen.size).toBe(2);
  });

  it('la asignación guardada no cambia al agregar un shard ni al desactivar el original', async () => {
    const walletId = await newWallet();
    const two = [
      { id: 'dev-1', url: dev1.url, active: true },
      { id: 'dev-2', url: dev2.url, active: true },
    ];
    const clients = new Map([
      ['dev-1', dev1.client],
      ['dev-2', dev2.client],
    ]);
    const first = await new SignerKeyService({ db: db.app, shards: two, clients }).ensureExecutor(walletId);
    const changed = [
      { id: 'dev-1', url: dev1.url, active: first.shardId !== 'dev-1' },
      { id: 'dev-2', url: dev2.url, active: first.shardId !== 'dev-2' },
      { id: 'dev-9', url: 'https://127.0.0.1:1', active: true },
    ];
    const later = new SignerKeyService({ db: db.app, shards: changed, clients });
    expect(await later.shardOf(walletId)).toBe(first.shardId);
    // La S de una rotación sale del mismo shard guardado.
    const rotation = await later.createRotationKey(walletId);
    expect(rotation).toMatchObject({ shardId: first.shardId, status: 'PENDING' });
    expect(rotation.address).not.toBe(first.address);
  });

  it('signer:reassign aplica una migración entre shards (dos fases ya hechas en el signer)', async () => {
    const walletId = await newWallet();
    const endpoints = [{ id: 'dev-1', url: dev1.url, active: true }];
    const service = new SignerKeyService({ db: db.app, shards: endpoints, clients: new Map([['dev-1', dev1.client]]) });
    const key = await service.ensureExecutor(walletId);
    const updated = await service.reassign([
      {
        walletId,
        address: key.address,
        fromShard: 'dev-1',
        toShard: 'dev-2',
        keyRef: `dev-2:${key.address.toLowerCase()}`,
      },
    ]);
    expect(updated).toBe(1);
    expect(await service.shardOf(walletId)).toBe('dev-2');
    // Una migración que no corresponde (otro shard de origen) no cambia nada.
    expect(
      await service.reassign([{ walletId, address: key.address, fromShard: 'dev-1', toShard: 'dev-3', keyRef: 'x' }]),
    ).toBe(0);
  });

  it('un cliente con certificado de otra CA no llega al shard (SIGNER_UNAVAILABLE)', async () => {
    const intruder = new SignerClient({
      shardId: 'dev-1',
      url: dev1.url,
      tls: {
        ca: readFileSync(pki.ca),
        cert: readFileSync(pki.foreignClient.cert),
        key: readFileSync(pki.foreignClient.key),
      },
    });
    try {
      await expect(intruder.health()).rejects.toMatchObject({ code: 'SIGNER_UNAVAILABLE', retryable: true });
      await expect(intruder.createKey({ walletId: crypto.randomUUID(), reason: 'ONBOARDING' })).rejects.toBeInstanceOf(
        SignerClientError,
      );
    } finally {
      intruder.close();
    }
    expect((await dev1.client.health()).ready).toBe(true);
  });

  it('los errores del signer llegan tipificados', async () => {
    await expect(dev1.client.createKey({ walletId: null, reason: 'ONBOARDING' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      retryable: false,
      status: 400,
    });
    await expect(dev1.client.signSafeTx({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
