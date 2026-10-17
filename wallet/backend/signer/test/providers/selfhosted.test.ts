// P11.T06 [B-SIG-08]: SelfHostedSoftwareSignerProvider (staging/producción) sobre una DB real:
// create (keystore V3 0400 + alta en la DB), load (conciliación directorio ↔ DB: faltante → BROKEN, sobrante → nunca
// firma), unlock por firma (sin caché de claves en claro), restart (fingerprint de la credencial), permisos y
// restore-verify. Ninguna clave privada queda en la DB.
import { chmodSync, copyFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex } from '../../src/crypto/bytes.ts';
import { keccak256 } from '../../src/crypto/keccak.ts';
import { generatePrivateKey, privateKeyToAddress, recoverStrict } from '../../src/crypto/secp256k1.ts';
import { deriveKeystorePassword } from '../../src/keystore/derive-password.ts';
import { credentialFingerprint } from '../../src/keystore/fingerprint.ts';
import { decryptKeystore, encryptKeystore } from '../../src/keystore/v3.ts';
import { SelfHostedSoftwareSignerProvider } from '../../src/providers/SelfHostedSoftwareSignerProvider.ts';
import { SignerProviderError } from '../../src/providers/SignerProvider.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { captureLogger } from '../helpers/logs.ts';
import { shardWorkspace, type ShardWorkspace } from '../helpers/shard.ts';
import { createMetrics } from '../../src/observability/metrics.ts';

let db: TestDatabase;
let ws: ShardWorkspace;
const logs = captureLogger();
const metrics = createMetrics({ defaultMetrics: false });

beforeAll(async () => {
  db = await createTestDatabase();
  ws = shardWorkspace('shard-a');
});
afterAll(async () => {
  await db.close();
  ws.cleanup();
});

const open = (credential = ws.credential()) =>
  SelfHostedSoftwareSignerProvider.open({
    shardId: 'shard-a',
    keystoreDir: ws.keystoreDir,
    credential,
    db: db.db,
    logger: logs.logger,
    metrics,
  });

const digest = keccak256(new TextEncoder().encode('digest de prueba'));

async function alarms(name: string): Promise<number> {
  const metric = await metrics.keystoreAlarms.get();
  return metric.values.find((v) => v.labels.alarm === name)?.value ?? 0;
}

describe('ciclo create → load → unlock → restart', () => {
  it('sin inicializar el shard no está listo y no crea claves', async () => {
    const provider = await open();
    expect(provider.name).toBe('selfhosted');
    expect((await provider.health()).problems).toContain('shard no inicializado (pnpm shard:create)');
    await expect(provider.createKey(crypto.randomUUID())).rejects.toBeInstanceOf(SignerProviderError);
    await provider.registry.initShard({
      provider: 'selfhosted',
      credentialFingerprint: credentialFingerprint(ws.credential()),
    });
  });

  it('create: keystore V3 0400 descifrable sólo con la contraseña derivada de la credencial; firma recuperable', async () => {
    const provider = await open();
    expect(provider.ready).toBe(true);
    const walletId = crypto.randomUUID();
    const { keyRef, address } = await provider.createKey(walletId);
    const file = join(ws.keystoreDir, `${address.toLowerCase()}.json`);
    const keystore = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const key = decryptKeystore(keystore, deriveKeystorePassword(ws.credential(), address), address);
    expect(privateKeyToAddress(key)).toBe(address);
    const signature = await provider.signDigest(keyRef, digest);
    expect(recoverStrict(digest, signature.bytes)).toBe(address);
    expect(BigInt(signature.s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true);
    expect([27, 28]).toContain(signature.v);
    // Determinística (RFC 6979): misma clave y digest → misma firma.
    expect((await provider.signDigest(keyRef, digest)).bytes).toBe(signature.bytes);
    const dump = await db.admin<{ dump: string }>(
      "SELECT string_agg(row_to_json(k)::text, ' ') AS dump FROM signer_keys k",
    );
    expect(dump.rows[0]!.dump).not.toContain(bytesToHex(key).slice(2));
    expect(await provider.registry.byRef(keyRef)).toMatchObject({ status: 'ACTIVE', kdfVersion: 1, walletId });
  });

  it('load: un keystore faltante deja la clave BROKEN (alarma) y no firma; los demás siguen', async () => {
    const provider = await open();
    const a = await provider.createKey(crypto.randomUUID());
    const b = await provider.createKey(crypto.randomUUID());
    const fileA = join(ws.keystoreDir, `${a.address.toLowerCase()}.json`);
    const saved = `${ws.root}/saved-${a.address}.json`;
    renameSync(fileA, saved);
    const before = await alarms('keystore_missing');
    const reopened = await open();
    expect(await alarms('keystore_missing')).toBe(before + 1);
    expect((await reopened.registry.byRef(a.keyRef))?.status).toBe('BROKEN');
    await expect(reopened.signDigest(a.keyRef, digest)).rejects.toThrow(/BROKEN/);
    expect(recoverStrict(digest, (await reopened.signDigest(b.keyRef, digest)).bytes)).toBe(b.address);
    // Restore del archivo + restore-verify: vuelve a ACTIVE.
    renameSync(saved, fileA);
    const report = await (await open()).verifyAll();
    expect(report.failed).toEqual([]);
    expect(report.verified).toContain(a.address);
    expect((await reopened.registry.byRef(a.keyRef))?.status).toBe('ACTIVE');
  });

  it('un keystore corrupto (MAC inválido) se detecta al firmar: BROKEN y alarma, sin firma', async () => {
    const provider = await open();
    const k = await provider.createKey(crypto.randomUUID());
    const file = join(ws.keystoreDir, `${k.address.toLowerCase()}.json`);
    const original = readFileSync(file, 'utf8');
    const ks = JSON.parse(original) as { crypto: { ciphertext: string } };
    ks.crypto.ciphertext = `${ks.crypto.ciphertext.slice(0, -2)}${ks.crypto.ciphertext.endsWith('00') ? '01' : '00'}`;
    chmodSync(file, 0o600);
    writeFileSync(file, JSON.stringify(ks));
    chmodSync(file, 0o400);
    const before = await alarms('keystore_mac_invalid');
    await expect(provider.signDigest(k.keyRef, digest)).rejects.toThrow(/keystore inutilizable \(MAC\)/);
    expect(await alarms('keystore_mac_invalid')).toBe(before + 1);
    expect((await provider.registry.byRef(k.keyRef))?.status).toBe('BROKEN');
    // Restore desde el backup (el archivo original) + restore-verify.
    chmodSync(file, 0o600);
    writeFileSync(file, original);
    chmodSync(file, 0o400);
    const report = await (await open()).verifyAll();
    expect(report.verified).toContain(k.address);
    expect((await provider.registry.byRef(k.keyRef))?.status).toBe('ACTIVE');
  });

  it('un keystore sin registro en la DB se reporta y nunca firma', async () => {
    const stray = generatePrivateKey();
    const address = privateKeyToAddress(stray);
    writeFileSync(
      join(ws.keystoreDir, `${address.toLowerCase()}.json`),
      JSON.stringify(encryptKeystore(stray, deriveKeystorePassword(ws.credential(), address))),
      { mode: 0o400 },
    );
    const before = await alarms('keystore_unexpected');
    const provider = await open();
    expect(await alarms('keystore_unexpected')).toBe(before + 1);
    await expect(provider.signDigest(`shard-a:${address.toLowerCase()}`, digest)).rejects.toThrow(/desconocida/);
    const report = await provider.verifyAll();
    expect(report.unexpectedFiles).toContain(`${address.toLowerCase()}.json`);
    unlinkSync(join(ws.keystoreDir, `${address.toLowerCase()}.json`));
  });

  it('restart con otra credencial: not ready, no firma y alarma de fingerprint', async () => {
    const other = shardWorkspace('otro');
    try {
      const before = await alarms('credential_fingerprint_mismatch');
      const provider = await open(other.credential());
      expect(provider.ready).toBe(false);
      expect(await alarms('credential_fingerprint_mismatch')).toBe(before + 1);
      const [key] = await provider.registry.list(['ACTIVE']);
      await expect(provider.signDigest(key!.keyRef, digest)).rejects.toThrow(/no listo/);
    } finally {
      other.cleanup();
    }
  });

  it('permisos: un keystore legible por otros o un directorio abierto dejan el shard no listo', async () => {
    const provider = await open();
    const [key] = await provider.registry.list(['ACTIVE']);
    const file = join(ws.keystoreDir, `${key!.address.toLowerCase()}.json`);
    chmodSync(file, 0o644);
    expect((await open()).problems.join(' ')).toMatch(/permisos 0644/);
    chmodSync(file, 0o400);
    chmodSync(ws.keystoreDir, 0o755);
    expect((await open()).problems.join(' ')).toMatch(/directorio de keystores con permisos 0755/);
    chmodSync(ws.keystoreDir, 0o700);
    expect((await open()).ready).toBe(true);
  });

  it('la credencial no puede estar dentro del directorio de keystores ni ser legible por otros', async () => {
    const { readCredentialFile } = await import('../../src/keystore/derive-password.ts');
    const inside = join(ws.keystoreDir, 'unlock.key');
    copyFileSync(ws.credentialFile, inside);
    chmodSync(inside, 0o600);
    expect(() => readCredentialFile(inside, { keystoreDir: ws.keystoreDir })).toThrow(
      /dentro del directorio de keystores/,
    );
    unlinkSync(inside);
    chmodSync(ws.credentialFile, 0o644);
    expect(() => readCredentialFile(ws.credentialFile, { keystoreDir: ws.keystoreDir })).toThrow(/otros usuarios/);
    chmodSync(ws.credentialFile, 0o600);
  });
});
