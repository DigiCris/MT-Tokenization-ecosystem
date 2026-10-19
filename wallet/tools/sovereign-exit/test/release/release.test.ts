// Release de la herramienta (P19.T09): dos builds reales en directorios distintos dan exactamente los mismos bytes
// (reproducible), el resultado es un único HTML con el JS y el CSS inline habilitados por su SHA-256 en la CSP, sin
// ningún recurso externo, y la firma Ed25519 de SHA256SUMS verifica con la pública (y no con otra, ni con el HTML
// alterado).
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HTML, signRelease } from '../../scripts/sign-release.ts';
import { verifyRelease } from '../../scripts/verify-release.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const work = mkdtempSync(join(tmpdir(), 'mtw-sovereign-exit-'));
const [first, second] = [join(work, 'a'), join(work, 'b')];

beforeAll(async () => {
  for (const outDir of [first, second]) {
    await build({
      root: ROOT,
      configFile: resolve(ROOT, 'vite.config.ts'),
      logLevel: 'error',
      build: { outDir, emptyOutDir: true },
    });
  }
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const sha = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

describe('build', () => {
  it('reproducible: dos builds, los mismos bytes; un único archivo', () => {
    expect(readdirSync(first)).toEqual([HTML]);
    expect(readFileSync(join(first, HTML)).equals(readFileSync(join(second, HTML)))).toBe(true);
  });

  it('JS y CSS inline habilitados por hash; sin recursos externos ni inline sin hash', () => {
    const html = readFileSync(join(first, HTML), 'utf8');
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    expect(scripts).toHaveLength(1);
    expect(styles).toHaveLength(1);
    expect(csp).toContain(`script-src ${sha(scripts[0]?.[1] ?? '')}`);
    expect(csp).toContain(`style-src ${sha(styles[0]?.[1] ?? '')}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("trusted-types 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(html).not.toMatch(/<(?:script|link|img|iframe)\b[^>]*\s(?:src|href)=/i);
  });
});

describe('firma del release', () => {
  it('SHA256SUMS firmado verifica con la pública; otra clave o el HTML alterado no', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    signRelease(first, privateKey);
    expect(() => {
      verifyRelease(first, publicKey);
    }).not.toThrow();
    expect(() => {
      verifyRelease(first, generateKeyPairSync('ed25519').publicKey);
    }).toThrow('no verifica');
    writeFileSync(join(first, HTML), `${readFileSync(join(first, HTML), 'utf8')}<!-- alterado -->`);
    expect(() => {
      verifyRelease(first, publicKey);
    }).toThrow('no es el firmado');
  });
});
