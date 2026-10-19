// Navegadores de Playwright dentro de la imagen fijada (scripts/tools/versions.json → testImages.playwright) para correr
// los tests de navegador en Firefox y WebKit en una máquina sin sus dependencias de sistema (P17.MAN, P22.T05): levanta
// `playwright run-server` de la versión instalada en el proyecto dentro del contenedor, con la red del host (el navegador
// llega a la vista previa y al stack por localhost), y devuelve el endpoint para PW_TEST_CONNECT_WS_ENDPOINT. El runner
// de tests sigue en el host con su Node; sólo los navegadores corren en el contenedor.
//
// Uso (las apps lo llaman como proceso, igual que scripts/stack/stack.mjs, sin importarlo):
//   node scripts/lib/browser-server.mjs start --project <dir de la app> --state <archivo>
//     escribe en el estado `{ "wsEndpoint": "ws://…" }` si hacen falta navegadores en el contenedor (ver
//     useBrowserServer) o `{}` si no; el contenedor queda corriendo en segundo plano.
//   node scripts/lib/browser-server.mjs stop --state <archivo>
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const WALLET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const BROWSER_IMAGE = JSON.parse(readFileSync(join(WALLET_ROOT, 'scripts/tools/versions.json'), 'utf8')).testImages
  .playwright;
export const BROWSERS = ['chromium', 'firefox', 'webkit'];

/** Navegadores pedidos con MTW_BROWSERS (lista separada por comas; por defecto, Chromium). */
export function requestedBrowsers(env = process.env) {
  const names = (env.MTW_BROWSERS ?? 'chromium')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !BROWSERS.includes(name));
  if (unknown.length > 0) throw new Error(`MTW_BROWSERS: navegadores desconocidos ${unknown.join(', ')}`);
  return names;
}

/**
 * Si los navegadores corren en el contenedor: con MTW_REMOTE_BROWSERS=1 siempre; con Firefox o WebKit pedidos, fuera de
 * GitHub Actions (allí `playwright install --with-deps` instala las dependencias en el runner).
 */
export function useBrowserServer(env = process.env) {
  if (env.MTW_REMOTE_BROWSERS === '1') return true;
  if (env.MTW_REMOTE_BROWSERS === '0' || env.GITHUB_ACTIONS) return false;
  return requestedBrowsers(env).some((name) => name !== 'chromium');
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function accepting(port) {
  return new Promise((resolveReady) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolveReady(true);
    });
    socket.once('error', () => resolveReady(false));
  });
}

function docker(args, options = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', stdio: options.inherit ? 'inherit' : 'pipe' });
}

/**
 * Levanta el servidor de navegadores para el proyecto (su node_modules trae @playwright/test de la misma versión que la
 * imagen) y devuelve `{ wsEndpoint, stop }`. `stop` borra el contenedor; también hay que llamarlo si los tests fallan.
 */
export async function startBrowserServer(projectRoot) {
  if (docker(['image', 'inspect', BROWSER_IMAGE]).status !== 0) {
    if (docker(['pull', '-q', BROWSER_IMAGE], { inherit: true }).status !== 0) {
      throw new Error(`no se pudo bajar la imagen de navegadores ${BROWSER_IMAGE}`);
    }
  }
  const port = await freePort();
  const name = `mtw-browsers-${String(process.pid)}-${String(port)}`;
  const started = docker([
    'run',
    '-d',
    '--rm',
    '--init',
    '--name',
    name,
    '--network',
    'host',
    // IPC del host (lo recomendado para Chromium); en Docker sobre WSL2 no existe /dev/mqueue y `--ipc host` no arranca:
    // ahí, memoria compartida amplia (la alternativa documentada por Playwright).
    ...(existsSync('/dev/mqueue') ? ['--ipc', 'host'] : ['--shm-size', '2g']),
    '-v',
    `${resolve(projectRoot)}:/project:ro`,
    '-w',
    '/project',
    '--entrypoint',
    'node',
    BROWSER_IMAGE,
    'node_modules/@playwright/test/cli.js',
    'run-server',
    '--port',
    String(port),
    '--host',
    '127.0.0.1',
  ]);
  if (started.status !== 0) throw new Error(`no arrancó el servidor de navegadores: ${started.stderr.trim()}`);
  const stop = () => {
    docker(['rm', '-f', name]);
  };
  const deadline = Date.now() + 60_000;
  while (!(await accepting(port))) {
    if (Date.now() > deadline || docker(['inspect', name]).status !== 0) {
      const logs = docker(['logs', name]);
      stop();
      throw new Error(`el servidor de navegadores no respondió en 60 s: ${`${logs.stdout}${logs.stderr}`.trim()}`);
    }
    await sleep(250);
  }
  return { name, wsEndpoint: `ws://127.0.0.1:${String(port)}/`, stop };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { project: { type: 'string' }, state: { type: 'string' } },
  });
  const [command] = positionals;
  if (!values.state || (command === 'start' && !values.project) || !['start', 'stop'].includes(command ?? '')) {
    process.stderr.write('uso: browser-server.mjs start --project <dir> --state <archivo> | stop --state <archivo>\n');
    process.exit(2);
  }
  if (command === 'start') {
    if (!useBrowserServer()) {
      writeFileSync(values.state, '{}\n');
    } else {
      const server = await startBrowserServer(values.project);
      writeFileSync(values.state, `${JSON.stringify({ name: server.name, wsEndpoint: server.wsEndpoint })}\n`);
      process.stderr.write(`navegadores (${requestedBrowsers().join(', ')}) en ${BROWSER_IMAGE.split('@')[0]}\n`);
    }
  } else {
    let state = {};
    try {
      state = JSON.parse(readFileSync(values.state, 'utf8'));
    } catch {
      // sin estado: no hay nada que borrar
    }
    if (typeof state.name === 'string') docker(['rm', '-f', state.name]);
  }
}
