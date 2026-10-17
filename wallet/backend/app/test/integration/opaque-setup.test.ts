// P10.T01: `pnpm opaque:setup` como proceso real sobre un .env temporal: genera OPAQUE_SERVER_SETUP sólo en local, sin
// imprimirlo, conserva el resto del archivo (comentario y permisos) y nunca reemplaza un valor existente.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as opaque from '@serenity-kit/opaque';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDotenv } from '../../src/config/dotenv.ts';

const APP = resolve(import.meta.dirname, '../..');
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mtw-opaque-setup-'));
  await opaque.ready;
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(envFile: string, env: Record<string, string> = {}) {
  const { APP_ENV: _ignored, ...base } = process.env;
  return spawnSync(process.execPath, ['src/cli/opaque-setup.ts'], {
    cwd: APP,
    env: { ...base, MTW_ENV_FILE: envFile, ...env },
    encoding: 'utf8',
  });
}

describe('opaque:setup', () => {
  it('genera el secreto en la línea existente, conserva comentario y permisos, y no lo imprime', () => {
    const file = join(dir, 'a.env');
    writeFileSync(
      file,
      'APP_ENV=local\nOTRA=1\nOPAQUE_SERVER_SETUP=                  # [GEN local] secreto OPAQUE\nFINAL=2\n',
      { mode: 0o600 },
    );
    const result = run(file);
    expect(result.status, result.stderr).toBe(0);
    const text = readFileSync(file, 'utf8');
    const values = parseDotenv(text);
    const setup = values.OPAQUE_SERVER_SETUP ?? '';
    expect(Buffer.from(setup, 'base64url')).toHaveLength(128);
    expect(() => opaque.server.getPublicKey(setup)).not.toThrow();
    expect(text).toContain('# [GEN local] secreto OPAQUE');
    expect(values).toMatchObject({ APP_ENV: 'local', OTRA: '1', FINAL: '2' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(result.stdout + result.stderr).not.toContain(setup);
    expect(result.stdout).toContain('OPAQUE_SERVER_SETUP generado');
  });

  it('no reemplaza un secreto existente', () => {
    const file = join(dir, 'b.env');
    writeFileSync(file, 'APP_ENV=local\n', { mode: 0o600 });
    expect(run(file).status).toBe(0);
    const before = readFileSync(file, 'utf8');
    const again = run(file);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('no se regenera');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(before.trimEnd().split('\n').at(-1)).toMatch(/^OPAQUE_SERVER_SETUP=[A-Za-z0-9_-]{171}$/);
  });

  it('se niega fuera de local', () => {
    const file = join(dir, 'c.env');
    writeFileSync(file, 'APP_ENV=staging\n');
    const fromFile = run(file);
    expect(fromFile.status).toBe(1);
    expect(fromFile.stderr).toContain('init-secrets.sh');
    const local = join(dir, 'd.env');
    writeFileSync(local, 'APP_ENV=local\n');
    expect(run(local, { APP_ENV: 'production' }).status).toBe(1);
    expect(readFileSync(local, 'utf8')).toBe('APP_ENV=local\n');
  });
});
