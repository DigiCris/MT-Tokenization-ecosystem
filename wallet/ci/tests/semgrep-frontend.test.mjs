// P16.SEC: las reglas Semgrep propias de los frontends (ci/semgrep/mtw-frontend.yml) detectan cada patrón prohibido
// en el src/ de una app y no marcan el código permitido (worker con createTrustedWorker, Web Storage en los módulos
// allowlisteados). Corre la imagen fijada de Semgrep sobre un árbol temporal con la misma estructura del repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WALLET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const image = JSON.parse(readFileSync(join(WALLET_ROOT, 'scripts/tools/versions.json'), 'utf8')).securityImages.semgrep;

const FILES = {
  'frontend/app/src/bad-html.ts': "export const f = (el: HTMLElement, h: string) => { el.insertAdjacentHTML('beforeend', h); document.write(h); };\n",
  'frontend/app/src/bad-storage.ts': "export const f = (v: string) => { localStorage.setItem('k', v); window.sessionStorage.setItem('k', v); };\n",
  'frontend/app/src/bad-worker.ts': "export const f = () => { new Worker('/assets/w.js'); navigator.serviceWorker.register('/sw.js'); };\n",
  'frontend/app/src/bad-postmessage.ts': "export const f = (w: Window) => { w.postMessage({ a: 1 }, '*'); };\n",
  'frontend/app/src/bad-script.ts': "export const f = () => document.head.append(document.createElement('script'));\n",
  'frontend/app/src/security/trusted-types.ts':
    "export const createTrustedWorker = (url: string) => new Worker(url, { type: 'module' });\n",
  'frontend/app/src/storage/flags.ts': "export const flag = () => localStorage.getItem('mtw.flag');\n",
  'frontend/app/src/ok.ts': "export const f = (w: Window, origin: string) => { w.postMessage({ a: 1 }, origin); };\n",
  'frontend/app/test/not-src.ts': "export const f = (h: string) => { document.write(h); };\n",
};

test('cada regla de frontend detecta su patrón en src/ y nada más', () => {
  const root = mkdtempSync(join(tmpdir(), 'mtw-semgrep-fe-'));
  try {
    for (const [path, content] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const run = spawnSync(
      'docker',
      [
        'run', '--rm', '-v', `${root}:/src:ro`, '-v', `${join(WALLET_ROOT, 'ci/semgrep')}:/rules:ro`,
        '-e', 'SEMGREP_SEND_METRICS=off', '-w', '/src', image,
        'semgrep', 'scan', '--metrics=off', '--quiet', '--disable-version-check', '--json',
        '--config', '/rules/mtw-frontend.yml', '.',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(run.status, 0, run.stderr);
    const findings = JSON.parse(run.stdout).results.map((r) => `${r.check_id.split('.').pop()} ${r.path}`);
    const by = (file) => findings.filter((f) => f.endsWith(file)).map((f) => f.split(' ')[0]).sort();
    assert.deepEqual(by('src/bad-html.ts'), ['mtw-fe-html-sinks', 'mtw-fe-html-sinks']);
    assert.deepEqual(by('src/bad-storage.ts'), ['mtw-fe-web-storage', 'mtw-fe-web-storage']);
    assert.deepEqual(by('src/bad-worker.ts'), ['mtw-fe-worker-string-url', 'mtw-fe-worker-string-url']);
    assert.deepEqual(by('src/bad-postmessage.ts'), ['mtw-fe-postmessage-wildcard']);
    assert.deepEqual(by('src/bad-script.ts'), ['mtw-fe-dynamic-script']);
    assert.deepEqual(by('src/security/trusted-types.ts'), []);
    assert.deepEqual(by('src/storage/flags.ts'), []);
    assert.deepEqual(by('src/ok.ts'), []);
    assert.deepEqual(by('test/not-src.ts'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
