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
  rpc: <T = unknown>(method: string, params?: unknown[]) => Promise<T>;
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

export async function startAnvil(options: AnvilOptions = {}): Promise<AnvilInstance> {
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
    args.push('--fork-url', options.upstream.url, '--fork-block-number', String(options.upstream.blockNumber));
  } else if (options.fork !== false) {
    args.push(
      '--fork-url',
      forkUpstreamUrl(),
      '--fork-block-number',
      String(forkBlockNumber()),
      // El RPC remoto limita el ritmo (429): más reintentos con backoff y un tope de unidades de cómputo por instancia.
      '--retries',
      '30',
      '--fork-retry-backoff',
      '1500',
      '--compute-units-per-second',
      '100',
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
    if (child.exitCode !== null) throw new Error(`anvil terminó al arrancar: ${stderr.slice(-300)}`);
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
    rpc: <T>(method: string, params: unknown[] = []) => jsonRpc<T>(url, method, params, 60_000),
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await exited;
      }
    },
  };
}
