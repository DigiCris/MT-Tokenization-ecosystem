// P16.TST: dos builds reales consecutivos con la configuración de la app (entorno de MTW_ENV, `local` por defecto) →
// manifests idénticos byte a byte; index.html sin scripts ni estilos inline y con SRI correcto en cada <script>/<link>;
// manifest firmado (clave de release efímera del test) verificable con la clave pública y que detecta un archivo
// alterado o una firma ajena; contratos del sistema del entorno emitidos, embebidos y listados en el manifest; headers de
// seguridad resueltos para el entorno; sin service worker.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROOT, loadBuildConfig } from '../../build/config.ts';
import { SECURITY_HEADERS_FILE, securityHeaders } from '../../build/headers.ts';
import { MANIFEST_FILE, SIGNATURE_FILE, type ReleaseManifest } from '../../build/manifest.ts';
import { signManifestBytes } from '../../build/sign-manifest.ts';
import { integrityOf } from '../../build/sri-plugin.ts';
import { serializeSystemContracts, systemContractsFileName, systemContractsOf } from '../../build/system-contracts.ts';
import { verifyRelease } from '../../build/verify-manifest.ts';

const config = loadBuildConfig();
const work = mkdtempSync(join(tmpdir(), 'mtw-recovery-release-'));
const [first, second] = [join(work, 'a'), join(work, 'b')] as const;

beforeAll(async () => {
  const tokens = spawnSync('node', ['scripts/sync-design-tokens.mjs'], { cwd: APP_ROOT, encoding: 'utf8' });
  if (tokens.status !== 0) throw new Error(`design tokens: ${tokens.stderr}`);
  for (const outDir of [first, second]) {
    await build({
      root: APP_ROOT,
      configFile: resolve(APP_ROOT, 'vite.config.ts'),
      logLevel: 'error',
      build: { outDir, emptyOutDir: true },
    });
  }
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const read = (dir: string, path: string) => readFileSync(join(dir, path));
const manifestOfDir = (dir: string) => JSON.parse(read(dir, MANIFEST_FILE).toString('utf8')) as ReleaseManifest;

describe('build reproducible', () => {
  it('dos builds consecutivos producen el mismo manifest, byte a byte', () => {
    expect(read(first, MANIFEST_FILE).equals(read(second, MANIFEST_FILE))).toBe(true);
  });

  it('el manifest declara app, entorno, release, commit y la fecha del commit', () => {
    expect(manifestOfDir(first)).toMatchObject({
      app: 'recovery',
      environment: config.environment,
      releaseId: config.releaseId,
      gitCommit: config.gitCommit,
      sourceDateEpoch: config.sourceDateEpoch,
    });
  });
});

describe('index.html', () => {
  const html = () => read(first, 'index.html').toString('utf8');

  it('sin scripts ni estilos inline ni atributos de evento', () => {
    expect(html()).not.toMatch(/<style\b/i);
    expect(html()).not.toMatch(/\sstyle="/i);
    expect(html()).not.toMatch(/\son[a-z]+="/i);
    for (const [, body] of html().matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) expect(body?.trim()).toBe('');
  });

  it('SRI correcto en cada <script> y <link>', () => {
    const tags = [...html().matchAll(/<(script|link)\b([^>]*)>/gi)];
    expect(tags.length).toBeGreaterThanOrEqual(2);
    for (const [, , attrs = ''] of tags) {
      const url = /\s(?:src|href)="([^"]+)"/.exec(attrs)?.[1];
      const integrity = /\sintegrity="([^"]+)"/.exec(attrs)?.[1];
      expect(url, attrs).toMatch(/^\/assets\//);
      expect(integrity, attrs).toBe(integrityOf(read(first, url!.slice(1))));
    }
  });
});

describe('manifest firmado', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  it('lista cada archivo publicado con su SHA-256 y verifica con la clave pública', () => {
    writeFileSync(join(first, SIGNATURE_FILE), signManifestBytes(read(first, MANIFEST_FILE), privateKey));
    const manifest = verifyRelease(first, publicKey);
    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain('index.html');
    expect(paths).toContain(systemContractsFileName(config.environment));
    expect(paths).toContain(SECURITY_HEADERS_FILE);
    expect(paths.some((p) => /^assets\/argon2\.worker-[\w-]+\.js$/.test(p))).toBe(true);
    expect(paths).not.toContain(MANIFEST_FILE);
  });

  it('un archivo alterado, uno agregado o una firma de otra clave no verifican', () => {
    const tampered = join(work, 'tampered');
    cpSync(first, tampered, { recursive: true });
    writeFileSync(join(tampered, 'index.html'), `${read(tampered, 'index.html').toString('utf8')}<!-- x -->`);
    expect(() => verifyRelease(tampered, publicKey)).toThrow(/hash distinto: index\.html/);

    const extra = join(work, 'extra');
    cpSync(first, extra, { recursive: true });
    writeFileSync(join(extra, 'assets/inyectado.js'), 'alert(1)');
    expect(() => verifyRelease(extra, publicKey)).toThrow(/no listado: assets\/inyectado\.js/);

    const other = generateKeyPairSync('ed25519');
    expect(() => verifyRelease(first, other.publicKey)).toThrow(/firma/);
  });
});

describe('contratos del sistema y headers del entorno', () => {
  it('system-contracts.<env>.json es el del deployment del entorno y está embebido en el bundle', () => {
    const expected = serializeSystemContracts(systemContractsOf(config));
    expect(read(first, systemContractsFileName(config.environment)).toString('utf8')).toBe(expected);
    const bundle = readdirSync(join(first, 'assets'))
      .filter((f) => /^index-[\w-]+\.js$/.test(f))
      .map((f) => read(first, `assets/${f}`).toString('utf8'))
      .join('\n');
    const guard = systemContractsOf(config).contracts.guard.address;
    expect(bundle).toContain(guard);
    expect(bundle).toContain(config.releaseId);
  });

  it('security-headers.json con los headers exactos del entorno', () => {
    const emitted = JSON.parse(read(first, SECURITY_HEADERS_FILE).toString('utf8')) as Record<string, unknown>;
    const expected = securityHeaders(config);
    expect(emitted).toEqual({ environment: config.environment, headers: expected.headers, routes: expected.routes });
  });

  it('sin service worker ni manifest de PWA', () => {
    const all = manifestOfDir(first).files.map((f) => f.path);
    expect(all.filter((p) => /(^|\/)(sw|service-?worker)[\w.-]*\.js$/i.test(p) || p.endsWith('.webmanifest'))).toEqual(
      [],
    );
    expect(existsSync(join(first, 'manifest.json'))).toBe(false);
  });
});
