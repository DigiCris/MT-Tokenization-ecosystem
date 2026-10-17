// P11.T10 [B-SIG-08]: cada procedimiento del ciclo de vida ejecutado de punta a punta con su CLI real sobre un shard de
// prueba (DB real, keystores en disco, `age` de la toolchain): alta del shard, backup cifrado sin la credencial,
// restore + restore-verify en un host "nuevo", keystore corrupto o faltante (BROKEN + restore), rotación de la
// credencial (re-cifrado, reanudable), custodia offline en dos copias selladas, migración entre shards en dos fases y
// destrucción de claves retiradas tras 30 días.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { utf8 } from '../../src/crypto/bytes.ts';
import { keccak256, type Address } from '../../src/crypto/keccak.ts';
import { recoverStrict } from '../../src/crypto/secp256k1.ts';
import { deriveKeystorePassword, readCredentialFile } from '../../src/keystore/derive-password.ts';
import { credentialFingerprint } from '../../src/keystore/fingerprint.ts';
import { decryptKeystore, encryptKeystore } from '../../src/keystore/v3.ts';
import { retireKey } from '../../src/lifecycle/retire.ts';
import { SelfHostedSoftwareSignerProvider } from '../../src/providers/SelfHostedSoftwareSignerProvider.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { captureLogger } from '../helpers/logs.ts';
import { SIGNER_ROOT } from '../helpers/paths.ts';

const logs = captureLogger();
const root = mkdtempSync(join(tmpdir(), 'mtw-lifecycle-'));
const digest = keccak256(utf8('lifecycle'));
let dbA: TestDatabase;
let dbRestored: TestDatabase;
let dbB: TestDatabase;

interface Shard {
  id: string;
  keystoreDir: string;
  credentialFile: string;
  db: TestDatabase;
}

function shardPaths(id: string, db: TestDatabase, base = root): Shard {
  return {
    id,
    keystoreDir: join(base, id, 'volume', 'keystore'),
    credentialFile: join(base, id, 'secrets', 'unlock.key'),
    db,
  };
}

function env(shard: Shard, prefix = ''): Record<string, string> {
  return {
    [`${prefix}SIGNER_SHARD_ID`]: shard.id,
    [`${prefix}SIGNER_PROVIDER`]: 'selfhosted',
    [`${prefix}SIGNER_KEYSTORE_DIR`]: shard.keystoreDir,
    [`${prefix}SIGNER_UNLOCK_CREDENTIAL_FILE`]: shard.credentialFile,
    [`${prefix}SIGNER_DATABASE_URL`]: shard.db.url,
  };
}

function cli(
  script: string,
  args: string[],
  extraEnv: Record<string, string>,
): { status: number; json: Record<string, unknown>; stderr: string } {
  const r = spawnSync('node', [resolve(SIGNER_ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, APP_ENV: 'local', MTW_ENV_FILE: join(root, 'no-env'), ...extraEnv },
  });
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: r.status ?? -1, json, stderr: r.stderr };
}

function ageIdentity(name: string): { identity: string; recipient: string } {
  const identity = join(root, `${name}.agekey`);
  const r = spawnSync('age-keygen', ['-o', identity], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`age-keygen falló: ${r.stderr}`);
  const recipient = /age1[0-9a-z]{58}/.exec(readFileSync(identity, 'utf8'))?.[0];
  if (recipient === undefined) throw new Error('sin destinatario age');
  return { identity, recipient };
}

async function openProvider(shard: Shard, credentialFile = shard.credentialFile) {
  return SelfHostedSoftwareSignerProvider.open({
    shardId: shard.id,
    keystoreDir: shard.keystoreDir,
    credential: readCredentialFile(credentialFile, { keystoreDir: shard.keystoreDir }),
    db: shard.db.db,
    logger: logs.logger,
  });
}

let shardA: Shard;
const wallets = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const keys: { keyRef: string; address: Address }[] = [];
const backupKey = { identity: '', recipient: '' };
let backupFile = '';

beforeAll(async () => {
  [dbA, dbRestored, dbB] = await Promise.all([createTestDatabase(), createTestDatabase(), createTestDatabase()]);
  shardA = shardPaths('shard-a', dbA);
  Object.assign(backupKey, ageIdentity('backup'));
});
afterAll(async () => {
  await Promise.all([dbA.close(), dbRestored.close(), dbB.close()]);
  rmSync(root, { recursive: true, force: true });
});

describe('alta del shard (shard:create)', () => {
  it('genera la credencial en otro directorio, registra el fingerprint y no repite el alta', async () => {
    const created = cli('create-shard.ts', ['--generate-credential'], env(shardA));
    expect(created.status, created.stderr).toBe(0);
    expect(created.json.shardId).toBe('shard-a');
    expect(statSync(shardA.keystoreDir).mode & 0o777).toBe(0o700);
    expect(statSync(shardA.credentialFile).mode & 0o777).toBe(0o400);
    expect(readdirSync(shardA.keystoreDir)).toEqual([]);
    expect(created.json.credentialFingerprint).toBe(credentialFingerprint(readCredentialFile(shardA.credentialFile)));
    expect(JSON.stringify(created.json)).not.toContain(readFileSync(shardA.credentialFile, 'utf8'));
    const again = cli('create-shard.ts', [], env(shardA));
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/ya existe/);
    const provider = await openProvider(shardA);
    for (const walletId of wallets) keys.push(await provider.createKey(walletId));
  });
});

describe('backup y restore (shard:backup, shard:restore, restore-verify)', () => {
  it('el backup cifrado con age incluye keystores y DB pero no la credencial', () => {
    backupFile = join(root, 'shard-a.backup.age');
    const result = cli('backup-shard.ts', ['--out', backupFile, '--recipient', backupKey.recipient], env(shardA));
    expect(result.status, result.stderr).toBe(0);
    expect(result.json.keystores).toBe(3);
    const encrypted = readFileSync(backupFile);
    expect(statSync(backupFile).mode & 0o777).toBe(0o600);
    expect(encrypted.toString('utf8')).not.toContain('ciphertext');
    const plain = spawnSync('age', ['-d', '-i', backupKey.identity], { input: encrypted }).stdout.toString('utf8');
    const bundle = JSON.parse(plain) as { keystores: unknown[]; tables: Record<string, unknown[]> };
    expect(bundle.keystores).toHaveLength(3);
    expect(bundle.tables.signer_keys).toHaveLength(3);
    expect(plain).not.toContain(readFileSync(shardA.credentialFile, 'utf8'));
  });

  it('restore en un host nuevo + restore-verify: las claves restauradas firman igual', async () => {
    const restored = shardPaths('shard-a', dbRestored, join(root, 'new-host'));
    mkdirSync(join(root, 'new-host', 'shard-a', 'secrets'), { recursive: true, mode: 0o700 });
    // La credencial llega por su custodia offline, no por el backup.
    writeFileSync(restored.credentialFile, readFileSync(shardA.credentialFile), { mode: 0o400 });
    const r = cli('restore-shard.ts', ['--in', backupFile, '--identity', backupKey.identity], env(restored));
    expect(r.status, r.stderr).toBe(0);
    expect(r.json.keystores).toBe(3);
    const verify = cli('restore-verify.ts', [], env(restored));
    expect(verify.status, verify.stderr).toBe(0);
    expect(verify.json).toMatchObject({ verified: 3, failed: [], unexpectedFiles: [] });
    const provider = await openProvider(restored);
    for (const k of keys)
      expect(recoverStrict(digest, (await provider.signDigest(k.keyRef, digest)).bytes)).toBe(k.address);
    // Restaurar sobre una DB o un directorio con datos se rechaza.
    expect(
      cli('restore-shard.ts', ['--in', backupFile, '--identity', backupKey.identity], env(restored)).stderr,
    ).toMatch(/vacía|vacío/);
  });

  it('un restore-verify sin la credencial correcta no da el shard por bueno', () => {
    const wrong = shardPaths('shard-a', dbRestored, join(root, 'new-host'));
    const other = join(root, 'other.key');
    writeFileSync(other, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'), { mode: 0o400 });
    const r = cli('restore-verify.ts', [], { ...env(wrong), SIGNER_UNLOCK_CREDENTIAL_FILE: other });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/fingerprint distinto/);
  });
});

describe('keystore corrupto o faltante (BROKEN + restore)', () => {
  it('MAC inválido al firmar → BROKEN; se restaura el archivo del backup y restore-verify lo reactiva', async () => {
    const provider = await openProvider(shardA);
    const target = keys[0]!;
    const file = join(shardA.keystoreDir, `${target.address.toLowerCase()}.json`);
    chmodSync(file, 0o600);
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(/"mac":"([0-9a-f])/, (_m, c: string) => `"mac":"${c === '0' ? '1' : '0'}`),
    );
    chmodSync(file, 0o400);
    await expect(provider.signDigest(target.keyRef, digest)).rejects.toThrow(/MAC/);
    expect((await provider.registry.byRef(target.keyRef))?.status).toBe('BROKEN');
    // Restore del archivo desde el backup cifrado.
    const plain = spawnSync('age', ['-d', '-i', backupKey.identity], {
      input: readFileSync(backupFile),
    }).stdout.toString('utf8');
    const bundle = JSON.parse(plain) as { keystores: { address: string; content: string }[] };
    const original = bundle.keystores.find((k) => k.address.toLowerCase() === target.address.toLowerCase())!;
    chmodSync(file, 0o600);
    writeFileSync(file, `${original.content}\n`);
    chmodSync(file, 0o400);
    const verify = cli('restore-verify.ts', [], env(shardA));
    expect(verify.status, verify.stderr).toBe(0);
    expect((await provider.registry.byRef(target.keyRef))?.status).toBe('ACTIVE');
    expect(recoverStrict(digest, (await (await openProvider(shardA)).signDigest(target.keyRef, digest)).bytes)).toBe(
      target.address,
    );
  });
});

describe('rotación de la credencial (credential:rotate)', () => {
  it('re-cifra todos los keystores (kdfVersion 2), reanuda un corte previo y deja la credencial vieja inútil', async () => {
    const newCredential = join(root, 'shard-a', 'secrets', 'unlock.v2.key');
    writeFileSync(newCredential, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'), {
      mode: 0o400,
    });
    // Corte simulado de una corrida anterior: un archivo ya quedó cifrado con la credencial nueva y la DB no lo sabe.
    const k = keys[1]!;
    const file = join(shardA.keystoreDir, `${k.address.toLowerCase()}.json`);
    const secret = decryptKeystore(
      JSON.parse(readFileSync(file, 'utf8')) as unknown,
      deriveKeystorePassword(readCredentialFile(shardA.credentialFile), k.address),
      k.address,
    );
    chmodSync(file, 0o600);
    writeFileSync(
      file,
      JSON.stringify(encryptKeystore(secret, deriveKeystorePassword(readCredentialFile(newCredential), k.address))),
    );
    chmodSync(file, 0o400);

    const r = cli('rotate-unlock-credential.ts', ['--new-credential', newCredential], env(shardA));
    expect(r.status, r.stderr).toBe(0);
    expect(r.json).toMatchObject({ reencrypted: 3, kdfVersion: 2, skippedBroken: [] });
    const withNew = await openProvider(shardA, newCredential);
    expect(withNew.ready).toBe(true);
    for (const key of keys)
      expect(recoverStrict(digest, (await withNew.signDigest(key.keyRef, digest)).bytes)).toBe(key.address);
    expect((await openProvider(shardA)).ready).toBe(false);
    // Montar la credencial nueva como la vigente (el operador reemplaza el secret y retira la anterior).
    chmodSync(shardA.credentialFile, 0o600);
    writeFileSync(shardA.credentialFile, readFileSync(newCredential));
    chmodSync(shardA.credentialFile, 0o400);
    expect((await openProvider(shardA)).ready).toBe(true);
  });
});

describe('custodia offline de la credencial (credential:escrow)', () => {
  it('dos copias selladas para custodios distintos; cualquiera recupera la credencial verificada', () => {
    const a = ageIdentity('custodio-a');
    const b = ageIdentity('custodio-b');
    const outDir = join(root, 'escrow');
    mkdirSync(outDir, { mode: 0o700 });
    expect(
      cli(
        'credential-escrow.ts',
        ['--out-dir', outDir, '--custodian', `uno=${a.recipient}`, '--custodian', `dos=${a.recipient}`],
        env(shardA),
      ).stderr,
    ).toMatch(/distintos/);
    const escrow = cli(
      'credential-escrow.ts',
      ['--out-dir', outDir, '--custodian', `uno=${a.recipient}`, '--custodian', `dos=${b.recipient}`],
      env(shardA),
    );
    expect(escrow.status, escrow.stderr).toBe(0);
    const files = escrow.json.files as string[];
    expect(files).toHaveLength(2);
    for (const f of files) expect(readFileSync(f, 'utf8')).not.toContain(readFileSync(shardA.credentialFile, 'utf8'));
    const recovered = join(root, 'recovered.key');
    const r = cli(
      'credential-escrow.ts',
      ['--recover', files[1]!, '--identity', b.identity, '--out', recovered],
      env(shardA),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(recovered, 'utf8')).toBe(readFileSync(shardA.credentialFile, 'utf8'));
    expect(statSync(recovered).mode & 0o777).toBe(0o400);
    // La copia de un custodio no la abre la identidad del otro.
    expect(
      cli(
        'credential-escrow.ts',
        ['--recover', files[1]!, '--identity', a.identity, '--out', join(root, 'x.key')],
        env(shardA),
      ).status,
    ).toBe(1);
  });
});

describe('migración entre shards (shard:migrate)', () => {
  it('fase 1: copia re-cifrada y verificada en destino (ACTIVE); fase 2: origen MIGRATED y sin firmar', async () => {
    const shardB = shardPaths('shard-b', dbB);
    expect(cli('create-shard.ts', ['--generate-credential'], env(shardB)).status).toBe(0);
    const moving = keys[2]!;
    const r = cli('shard-migrate.ts', ['--wallet', wallets[2]!], { ...env(shardA), ...env(shardB, 'TARGET_') });
    expect(r.status, r.stderr).toBe(0);
    expect(r.json.moved).toEqual([
      {
        walletId: wallets[2],
        address: moving.address,
        fromShard: 'shard-a',
        toShard: 'shard-b',
        keyRef: `shard-b:${moving.address.toLowerCase()}`,
      },
    ]);
    const target = await openProvider(shardB);
    expect(
      recoverStrict(digest, (await target.signDigest(`shard-b:${moving.address.toLowerCase()}`, digest)).bytes),
    ).toBe(moving.address);
    // El keystore destino está cifrado con la credencial destino, no con la de origen.
    const destinationFile = JSON.parse(
      readFileSync(join(shardB.keystoreDir, `${moving.address.toLowerCase()}.json`), 'utf8'),
    ) as unknown;
    expect(() =>
      decryptKeystore(
        destinationFile,
        deriveKeystorePassword(readCredentialFile(shardA.credentialFile), moving.address),
      ),
    ).toThrow();
    const source = await openProvider(shardA);
    expect((await source.registry.byRef(moving.keyRef))?.status).toBe('MIGRATED');
    await expect(source.signDigest(moving.keyRef, digest)).rejects.toThrow(/MIGRATED/);
    // Una wallet sin S activa en el origen no se migra.
    expect(
      cli('shard-migrate.ts', ['--wallet', wallets[2]!], { ...env(shardA), ...env(shardB, 'TARGET_') }).status,
    ).toBe(1);
  });
});

describe('destrucción de claves retiradas (shard:destroy-retired)', () => {
  it('a los 30 días del retiro el keystore se borra; antes, queda pendiente', async () => {
    const provider = await openProvider(shardA);
    const victim = keys[0]!;
    const retiredAt = new Date();
    await retireKey(provider.registry, victim.keyRef, retiredAt);
    await expect(provider.signDigest(victim.keyRef, digest)).rejects.toThrow(/RETIRED/);
    const early = cli(
      'destroy-retired.ts',
      ['--now', new Date(retiredAt.getTime() + 24 * 3600_000).toISOString()],
      env(shardA),
    );
    expect(early.json).toMatchObject({ destroyed: [] });
    const late = cli(
      'destroy-retired.ts',
      ['--now', new Date(retiredAt.getTime() + 31 * 24 * 3600_000).toISOString()],
      env(shardA),
    );
    expect(late.status, late.stderr).toBe(0);
    expect(late.json.destroyed).toEqual([victim.address]);
    expect(existsSync(join(shardA.keystoreDir, `${victim.address.toLowerCase()}.json`))).toBe(false);
    expect((await provider.registry.byRef(victim.keyRef))?.status).toBe('DESTROYED');
  });
});
