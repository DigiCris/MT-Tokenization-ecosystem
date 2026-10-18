// Anvil sobre el fork de Base (bloque fijado de config/chains/base-mainnet.json). El upstream es BASE_RPC_URL (o
// FORK_RPC_URL): en CI llega del secret; en local se lee de wallet/.env. Sin upstream los tests fallan (no se saltean).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseDotenv } from '../../src/config/dotenv.ts';

const WALLET_ROOT = resolve(import.meta.dirname, '../../../..');

export function forkBlockNumber(): number {
  const chain = JSON.parse(readFileSync(resolve(WALLET_ROOT, 'config/chains/base-mainnet.json'), 'utf8')) as {
    fork?: { blockNumber?: number };
    forkBlockNumber?: number;
  };
  const block = chain.fork?.blockNumber ?? chain.forkBlockNumber;
  if (typeof block !== 'number') throw new Error('config/chains/base-mainnet.json sin bloque de fork');
  return block;
}

export function forkUpstreamUrl(): string {
  const fromEnv = process.env.FORK_RPC_URL ?? process.env.BASE_RPC_URL;
  if (fromEnv) return fromEnv;
  const envFile = resolve(WALLET_ROOT, '.env');
  const value = existsSync(envFile) ? parseDotenv(readFileSync(envFile, 'utf8')).BASE_RPC_URL : undefined;
  if (!value) throw new Error('falta BASE_RPC_URL (o FORK_RPC_URL) para levantar Anvil sobre el fork de Base');
  return value;
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolvePort(address.port);
        else reject(new Error('sin puerto'));
      });
    });
  });
}

export interface AnvilInstance {
  url: string;
  port: number;
  stop: () => Promise<void>;
  rpc: <T = unknown>(method: string, params?: unknown[]) => Promise<T>;
}

export async function rpcCall<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

export interface AnvilOptions {
  /** Estado a cargar (`anvil_dumpState` del sistema desplegado en el global setup). */
  loadState?: string;
}

/** Anvil forkeando Base en el bloque fijado (chainId 8453), sin minado automático por tiempo. */
export async function startAnvil(options: AnvilOptions = {}): Promise<AnvilInstance> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(
    'anvil',
    [
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--fork-url',
      forkUpstreamUrl(),
      '--fork-block-number',
      String(forkBlockNumber()),
      '--chain-id',
      '8453',
      // El RPC remoto limita el ritmo (429): más reintentos con backoff y un tope de unidades de cómputo por instancia.
      '--retries',
      '30',
      '--fork-retry-backoff',
      '1500',
      '--compute-units-per-second',
      '100',
      '--timeout',
      '60000',
      '--silent',
      ...(options.loadState === undefined ? [] : ['--load-state', options.loadState]),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));

  // Cargar el estado del sistema (--load-state) con varios forks arrancando a la vez puede tardar.
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`anvil terminó al arrancar: ${stderr.slice(-300)}`);
    try {
      await rpcCall(url, 'eth_chainId');
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error('anvil no respondió en 180 s');
      }
      await sleep(250);
    }
  }
  return {
    url,
    port,
    rpc: (method, params) => rpcCall(url, method, params),
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await exited;
      }
    },
  };
}
