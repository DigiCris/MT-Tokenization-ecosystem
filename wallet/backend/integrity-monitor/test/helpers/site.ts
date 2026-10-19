// Release de prueba servido por HTTP real, con la misma forma que los builds de Wallet y Recovery: index.html con
// script, modulepreload y hoja de estilo con SRI sha384, assets, `.well-known/security-headers.json` (headers
// generales y por ruta), manifest [W-04] en JSON canónico firmado con Ed25519, fallback de SPA a index.html y 403 a
// los pedidos de script de service worker. Los tests alteran los archivos en disco para simular un frontend comprometido.
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { canonicalize } from '../../src/jcs.ts';

export interface TestSite {
  url: string;
  dir: string;
  releaseKey: { privateKey: KeyObject; publicKey: KeyObject };
  /** Reescribe un archivo del sitio (sin tocar el manifest). */
  write: (path: string, content: string) => void;
  read: (path: string) => string;
  /** Vuelve a generar el manifest y su firma con el contenido actual (un release legítimo nuevo). */
  republish: (releaseId?: string) => void;
  /** Cambia un header servido (null lo quita). */
  overrideHeader: (name: string, value: string | null) => void;
  close: () => Promise<void>;
}

export const SITE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; require-trusted-types-for 'script'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=()',
};

const sri = (content: string) => `sha384-${createHash('sha384').update(content).digest('base64')}`;

function walk(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full, root) : [relative(root, full).split(sep).join('/')];
  });
}

export async function startSite(
  options: { app?: 'wallet' | 'recovery'; environment?: string } = {},
): Promise<TestSite> {
  const app = options.app ?? 'recovery';
  const environment = options.environment ?? 'local';
  const dir = mkdtempSync(join(tmpdir(), 'mtw-integrity-site-'));
  const releaseKey = generateKeyPairSync('ed25519');
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const js = "import './chunk-a1.js';\nconsole.log('mtw');\n";
  const chunk = 'export const answer = 42;\n';
  const css = 'body{margin:0}\n';
  put('assets/index-a1.js', js);
  put('assets/chunk-a1.js', chunk);
  put('assets/index-a1.css', css);
  put('favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  put(
    'index.html',
    [
      '<!doctype html>',
      '<html lang="es"><head><meta charset="utf-8">',
      '<link rel="icon" href="/favicon.svg">',
      `<script type="module" crossorigin src="/assets/index-a1.js" integrity="${sri(js)}"></script>`,
      `<link rel="modulepreload" crossorigin href="/assets/chunk-a1.js" integrity="${sri(chunk)}">`,
      `<link rel="stylesheet" crossorigin href="/assets/index-a1.css" integrity="${sri(css)}">`,
      '</head><body><div id="root"></div></body></html>',
      '',
    ].join('\n'),
  );
  put(
    '.well-known/security-headers.json',
    JSON.stringify({
      environment,
      headers: SITE_HEADERS,
      routes: { '/restore': { 'Permissions-Policy': 'camera=(self), microphone=()' } },
    }),
  );
  const republish = (releaseId = `${app}-${environment}-0000000000a1`) => {
    const files = walk(dir)
      .filter((p) => !p.startsWith('.well-known/release-manifest'))
      .sort()
      .map((path) => {
        const bytes = readFileSync(join(dir, path));
        return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: statSync(join(dir, path)).size };
      });
    const manifest = canonicalize({
      app,
      environment,
      releaseId,
      gitCommit: 'a'.repeat(40),
      sourceDateEpoch: 1_792_000_000,
      files,
    });
    put('.well-known/release-manifest.json', manifest);
    put(
      '.well-known/release-manifest.json.sig',
      sign(null, Buffer.from(manifest), releaseKey.privateKey).toString('base64'),
    );
  };
  republish();

  const overrides = new Map<string, string | null>();
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const spec = JSON.parse(readFileSync(join(dir, '.well-known/security-headers.json'), 'utf8')) as {
      headers: Record<string, string>;
      routes: Record<string, Record<string, string>>;
    };
    const route = Object.keys(spec.routes).find((r) => pathname === r || pathname.startsWith(`${r}/`));
    const headers: Record<string, string> = { ...spec.headers, ...(route ? spec.routes[route] : {}) };
    for (const [name, value] of overrides) {
      if (value === null) Reflect.deleteProperty(headers, name);
      else headers[name] = value;
    }
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    if (req.headers['service-worker'] === 'script') {
      res.writeHead(403).end('Service workers deshabilitados');
      return;
    }
    const file = join(dir, pathname.slice(1));
    let target = file;
    try {
      if (!statSync(file).isFile()) target = join(dir, 'index.html');
    } catch {
      target = pathname.includes('.') && !pathname.startsWith('/restore') ? '' : join(dir, 'index.html');
    }
    if (target === '') {
      res.writeHead(404).end('no existe');
      return;
    }
    res.writeHead(200).end(readFileSync(target));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('sin puerto');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    dir,
    releaseKey,
    write: put,
    read: (path) => readFileSync(join(dir, path), 'utf8'),
    republish,
    overrideHeader: (name, value) => overrides.set(name, value),
    close: async () => {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
