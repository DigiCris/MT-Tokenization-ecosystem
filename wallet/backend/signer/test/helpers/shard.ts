// Directorios de un shard de prueba: `<root>/<shard>/keystore` (0700) y la credencial de desbloqueo en
// `<root>/<shard>/unlock.key` (0600, fuera del directorio de keystores), como los genera `pnpm secrets:local`.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCredentialFile } from '../../src/keystore/derive-password.ts';
import type { Secret } from '../../src/config/secret.ts';

export interface ShardWorkspace {
  root: string;
  keystoreDir: string;
  credentialFile: string;
  credential: () => Secret<Uint8Array>;
  cleanup: () => void;
}

export function shardWorkspace(shardId = 'dev-1', root = mkdtempSync(join(tmpdir(), 'mtw-signer-'))): ShardWorkspace {
  const base = join(root, 'signer', shardId);
  const keystoreDir = join(base, 'keystore');
  mkdirSync(keystoreDir, { recursive: true, mode: 0o700 });
  const credentialFile = join(base, 'unlock.key');
  writeFileSync(credentialFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  return {
    root: join(root, 'signer'),
    keystoreDir,
    credentialFile,
    credential: () => readCredentialFile(credentialFile, { keystoreDir }),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
