// Anvil sobre el fork de Base (bloque fijado), opcionalmente con el estado del deploy del sistema cargado
// (`--load-state`, generado una vez por corrida en el global setup).
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { jsonRpc } from '../../src/chain/json-rpc.ts';
import { forkBlockNumber, forkUpstreamUrl } from './paths.ts';

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') resolvePort(address.port);
        else reject(new Error('sin puerto'));
      });
    });
  });
}

export interface AnvilInstance {
  url: string;
  /** Pedido JSON-RPC; espera hasta `timeoutMs` (60 s por defecto). */
  rpc: <T = unknown>(method: string, params?: unknown[], timeoutMs?: number) => Promise<T>;
  stop: () => Promise<void>;
}

export interface AnvilOptions {
  /** Estado a cargar (`anvil_dumpState` del global setup). */
  loadState?: string;
  /** false: Anvil sin fork (para probar las guardas del provider de desarrollo). */
  fork?: boolean;
  /** Upstream propio (otro Anvil) en lugar del RPC de Base: dos nodos con la misma historia hasta `blockNumber`. */
  upstream?: { url: string; blockNumber: bigint };
  chainId?: number;
}

/**
 * Anvil (por defecto forkeando Base en el bloque fijado). Si el proceso termina al arrancar (el RPC remoto del fork,
 * compartido en CI, falló o limitó el ritmo justo en ese momento), se reintenta con espera creciente.
 */
export async function startAnvil(options: AnvilOptions = {}): Promise<AnvilInstance> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await launchAnvil(options);
    } catch (error) {
      if (!(error instanceof AnvilExitedError) || attempt >= 4) throw error;
      await sleep(attempt * 3_000);
    }
  }
}

class AnvilExitedError extends Error {
  override name = 'AnvilExitedError';
}

async function launchAnvil(options: AnvilOptions): Promise<AnvilInstance> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const args = [
    '--port',
    String(port),
    '--host',
    '127.0.0.1',
    '--chain-id',
    String(options.chainId ?? 8453),
    '--silent',
  ];
  if (options.upstream !== undefined) {
    args.push(
      '--fork-url',
      options.upstream.url,
      '--fork-block-number',
      String(options.upstream.blockNumber),
      // El upstream es otro Anvil que, si no tiene el estado, lo trae del RPC remoto con sus propios reintentos: se
      // lo espera más que a un pedido de ese Anvil (60 s) en lugar del timeout por defecto.
      '--retries',
      '10',
      '--fork-retry-backoff',
      '2000',
      '--timeout',
      '180000',
    );
  } else if (options.fork !== false) {
    args.push(
      '--fork-url',
      forkUpstreamUrl(),
      '--fork-block-number',
      String(forkBlockNumber()),
      // El chain id del fork se conoce: no se le pide al RPC remoto al arrancar.
      '--fork-chain-id',
      '8453',
      // El RPC remoto limita el ritmo (429; ~500 CU/s para toda la key, que comparten los jobs de CI en paralelo,
      // docs/CI.md#presupuesto-del-rpc-del-fork): tope de 80 CU/s por instancia y reintentos con backoff para
      // absorber las ráfagas.
      '--retries',
      '60',
      '--fork-retry-backoff',
      '2000',
      '--compute-units-per-second',
      '80',
      '--timeout',
      '60000',
    );
  }
  if (options.loadState !== undefined) args.push('--load-state', options.loadState);
  const child: ChildProcess = spawn('anvil', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<void>((resolveExit) =>
    child.once('exit', () => {
      resolveExit();
    }),
  );
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new AnvilExitedError(`anvil terminó al arrancar: ${stderr.slice(-300)}`);
    try {
      await jsonRpc(url, 'eth_chainId', [], 2_000);
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error('anvil no respondió en 90 s');
      }
      await sleep(250);
    }
  }
  return {
    url,
    rpc: <T>(method: string, params: unknown[] = [], timeoutMs = 60_000) => jsonRpc<T>(url, method, params, timeoutMs),
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await exited;
      }
    },
  };
}
