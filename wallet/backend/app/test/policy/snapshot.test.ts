// Snapshot de policy firmado en el backend [B-POL-01]: se acepta sólo con la firma Ed25519 de la clave de policy fijada
// sobre los bytes exactos del archivo, con el formato esperado y del entorno del proceso.
import { createHash, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getAddress } from 'viem';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPolicySnapshot, PolicySnapshotError } from '../../src/policy/snapshot.ts';
import { edKey, writePolicySnapshot } from '../helpers/signer-shard.ts';

const system = JSON.parse(readFileSync(resolve(import.meta.dirname, '../vectors/system.json'), 'utf8')) as {
  contracts: Record<string, string>;
};
const deployment = {
  SecurityGuard: system.contracts.securityGuard,
  RotationTimelock: system.contracts.rotationTimelock,
  WalletFactory: system.contracts.walletFactory,
  SafeBootstrap: system.contracts.safeBootstrap,
  PolicyRegistry: system.contracts.policyRegistry,
  DestinationWhitelist: system.contracts.destinationWhitelist,
  DenyAllModuleGuard: system.contracts.denyAllModuleGuard,
  SwapExecutorV3: system.contracts.swapExecutor,
} as Record<string, string>;

const dirs: string[] = [];
const key = edKey();

function written(version = 1): string {
  const dir = mkdtempSync(join(tmpdir(), 'mtw-policy-'));
  dirs.push(dir);
  return writePolicySnapshot(dir, key, deployment, version);
}

/** Firma bytes arbitrarios con la clave de policy (formato inválido pero firma válida). */
function resigned(path: string, bytes: Buffer): void {
  writeFileSync(path, bytes);
  writeFileSync(`${path}.sig`, sign(null, bytes, key.privateKey).toString('base64'));
}

function failure(path: string, environment = 'local'): string {
  try {
    loadPolicySnapshot(path, key.publicKey, environment);
  } catch (error) {
    expect(error).toBeInstanceOf(PolicySnapshotError);
    return (error as Error).message;
  }
  throw new Error('el snapshot se aceptó');
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('snapshot de policy del backend', () => {
  it('acepta el snapshot firmado del entorno: versión, contratos con checksum y sha256 de los bytes', () => {
    const path = written(7);
    const snapshot = loadPolicySnapshot(path, key.publicKey, 'local');
    expect(snapshot.version).toBe(7);
    expect(snapshot.environment).toBe('local');
    expect(snapshot.chainId).toBe(8453);
    expect(snapshot.contracts.walletFactory).toBe(getAddress(system.contracts.walletFactory ?? ''));
    expect(snapshot.sha256).toBe(`0x${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
  });

  it('rechaza un snapshot sin firma o ilegible', () => {
    const path = written();
    rmSync(`${path}.sig`);
    expect(failure(path)).toMatch(/no se puede leer/);
    expect(failure(join(dirs[0] ?? '', 'no-existe.json'))).toMatch(/no se puede leer/);
  });

  it('rechaza bytes modificados, la firma de otra clave y una firma de largo inválido', () => {
    const tampered = written();
    const bytes = readFileSync(tampered);
    writeFileSync(tampered, Buffer.from(bytes.toString('utf8').replace('"version": 1', '"version": 9')));
    expect(failure(tampered)).toMatch(/firma del snapshot de policy inválida/);

    const otherKey = written();
    writeFileSync(`${otherKey}.sig`, sign(null, readFileSync(otherKey), edKey().privateKey).toString('base64'));
    expect(failure(otherKey)).toMatch(/firma del snapshot de policy inválida/);

    const shortSig = written();
    writeFileSync(`${shortSig}.sig`, Buffer.alloc(32).toString('base64'));
    expect(failure(shortSig)).toMatch(/firma del snapshot de policy inválida/);
  });

  it('rechaza un archivo firmado con formato inválido y el snapshot de otro entorno', () => {
    const path = written();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    resigned(path, Buffer.from(JSON.stringify({ ...parsed, chainId: 1 })));
    expect(failure(path)).toMatch(/formato inválido/);
    resigned(path, Buffer.from(JSON.stringify({ ...parsed, contracts: { walletFactory: '0x1234' } })));
    expect(failure(path)).toMatch(/formato inválido/);
    resigned(path, Buffer.from('no es json'));
    expect(failure(path)).toMatch(/formato inválido/);

    expect(failure(written(), 'production')).toMatch(/el snapshot es de local/);
  });
});
