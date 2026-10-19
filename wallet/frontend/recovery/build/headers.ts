// Headers de seguridad de la app Recovery (P16.T05) a partir de build/headers.json: CSP de [F-SEC-01] con los hosts del
// entorno, HSTS, COOP/COEP/CORP, Referrer-Policy, nosniff y Permissions-Policy mínima (cámara sólo en las rutas que
// escanean QR). El plugin los aplica a toda respuesta de `vite preview` (y de `vite` en dev), responde 403 a los pedidos
// de scripts de service worker ([F-SEC-04]) y emite dist/.well-known/security-headers.json para el contenedor estático
// recovery-web de P26 y el integrity monitor de P20 (cubierto por el manifest firmado).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { APP_ROOT, type BuildConfig } from './config.ts';
import { canonicalize } from './jcs.ts';

interface HeaderSpec {
  headers: Record<string, string>;
  permissionsPolicy: { deny: string[]; cameraRoutes: string[] };
  csp: Record<string, string[]>;
  remoteOnly: string[];
}

export interface SecurityHeaders {
  /** Headers de toda respuesta. */
  headers: Record<string, string>;
  /** Overrides para los documentos de ciertas rutas (y sus subrutas). */
  routes: Record<string, Record<string, string>>;
}

export const SECURITY_HEADERS_FILE = '.well-known/security-headers.json';

export function loadHeaderSpec(): HeaderSpec {
  return JSON.parse(readFileSync(resolve(APP_ROOT, 'build/headers.json'), 'utf8')) as HeaderSpec;
}

/**
 * Headers resueltos para un entorno. En dev (`vite` con HMR) la CSP agrega lo mínimo que necesita el servidor de
 * desarrollo: el websocket de HMR y 'unsafe-inline' en style-src porque Vite inyecta el CSS como <style>; el build y
 * `vite preview` usan la política exacta.
 */
export function securityHeaders(
  config: Pick<BuildConfig, 'environment' | 'apiOrigin' | 'rpcOrigin'>,
  dev?: { hmrOrigin: string },
  spec: HeaderSpec = loadHeaderSpec(),
): SecurityHeaders {
  const remote = config.environment === 'staging' || config.environment === 'production';
  const directives = Object.entries(spec.csp)
    .filter(([name]) => remote || !spec.remoteOnly.includes(name))
    .map(([name, values]) => {
      let resolved = values.map((v) =>
        v.replace('{apiOrigin}', config.apiOrigin).replace('{rpcOrigin}', config.rpcOrigin),
      );
      if (dev && name === 'style-src') resolved = [...resolved, "'unsafe-inline'"];
      if (dev && name === 'connect-src') resolved = [...resolved, dev.hmrOrigin];
      // Sin duplicados (p. ej. API y RPC en el mismo origin), conservando el orden.
      return [name, ...new Set(resolved)].join(' ');
    });
  const permissions = (camera: boolean) =>
    spec.permissionsPolicy.deny
      .map((feature) => (feature === 'camera' && camera ? 'camera=(self)' : `${feature}=()`))
      .join(', ');
  const headers = {
    ...spec.headers,
    'Content-Security-Policy': directives.join('; '),
    'Permissions-Policy': permissions(false),
  };
  const routes = Object.fromEntries(
    spec.permissionsPolicy.cameraRoutes.map((route) => [route, { 'Permissions-Policy': permissions(true) }]),
  );
  return { headers, routes };
}

/** Headers para una ruta concreta: los generales más los de su ruta (o de la ruta que la contiene). */
export function headersFor(security: SecurityHeaders, pathname: string): Record<string, string> {
  const route = Object.keys(security.routes).find((r) => pathname === r || pathname.startsWith(`${r}/`));
  return route === undefined ? security.headers : { ...security.headers, ...security.routes[route] };
}

function middleware(security: SecurityHeaders): Connect.NextHandleFunction {
  return (req, res, next) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    for (const [name, value] of Object.entries(headersFor(security, pathname))) res.setHeader(name, value);
    // [F-SEC-04]: ningún script de service worker se sirve, aunque el archivo exista.
    if (req.headers['service-worker'] === 'script') {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Service workers deshabilitados');
      return;
    }
    next();
  };
}

export function securityHeadersPlugin(config: BuildConfig): Plugin {
  const exact = securityHeaders(config);
  return {
    name: 'mtw:security-headers',
    configureServer(server) {
      const port = server.config.server.port;
      server.middlewares.use(middleware(securityHeaders(config, { hmrOrigin: `ws://localhost:${String(port)}` })));
    },
    configurePreviewServer(server) {
      // `vite preview` sirve un build: aplica los headers que ese build emitió (como el contenedor estático de
      // producción), no los que daría el entorno del proceso de preview.
      const emitted = resolve(server.config.root, server.config.build.outDir, SECURITY_HEADERS_FILE);
      const built = existsSync(emitted) ? (JSON.parse(readFileSync(emitted, 'utf8')) as SecurityHeaders) : exact;
      server.middlewares.use(middleware({ headers: built.headers, routes: built.routes }));
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: SECURITY_HEADERS_FILE,
        source: canonicalize({ environment: config.environment, headers: exact.headers, routes: exact.routes }),
      });
    },
  };
}
