// Anvil sobre el fork de Base (bloque fijado de config/chains/base-mainnet.json). El upstream es BASE_RPC_URL (o
// FORK_RPC_URL): en CI llega del secret; en local se lee de wallet/.env. Sin upstream los tests fallan (no se saltean).
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  HttpRequestError,
  TimeoutError,
  TransactionReceiptNotFoundError,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
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

/**
 * Anvil forkeando Base en el bloque fijado (chainId 8453), sin minado automático por tiempo. Si el proceso termina
 * al arrancar (el RPC remoto del fork, compartido en CI, falló o limitó el ritmo justo en ese momento), se reintenta
 * con espera creciente.
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

/**
 * Con MTW_ANVIL_LOG_DIR cada Anvil escribe su log (RPC recibidos, transacciones y bloques) en un archivo propio de ese
 * directorio, con el archivo de test que lo levantó: CI lo sube como artefacto si el job falla. El banner de Anvil
 * imprime el endpoint del fork (con la key del proveedor): toda URL que no sea local se reduce a su host antes de
 * escribir. Sin la variable, Anvil corre en silencio.
 */
function anvilLog(port: number): number | null {
  const dir = process.env.MTW_ANVIL_LOG_DIR;
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  const testFile = /\/(test\/[\w/.-]+\.test\.ts)/.exec(new Error().stack ?? '')?.[1] ?? 'global-setup';
  const fd = openSync(resolve(dir, `anvil-${String(Date.now())}-${String(port)}.log`), 'a');
  writeSync(fd, `# ${testFile}\n`);
  return fd;
}

async function launchAnvil(options: AnvilOptions): Promise<AnvilInstance> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const logFd = anvilLog(port);
  const upstream = forkUpstreamUrl();
  const redact = (text: string) =>
    text
      .split(upstream)
      .join('<fork-upstream>')
      .replace(/(https?:\/\/(?!127\.0\.0\.1|localhost)[^\s/'"]+)[^\s'"]*/g, '$1/<redactado>');
  const child: ChildProcess = spawn(
    'anvil',
    [
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--fork-url',
      upstream,
      '--fork-block-number',
      String(forkBlockNumber()),
      '--chain-id',
      '8453',
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
      ...(logFd === null ? ['--silent'] : []),
      ...(options.loadState === undefined ? [] : ['--load-state', options.loadState]),
    ],
    { stdio: ['ignore', logFd === null ? 'ignore' : 'pipe', 'pipe'] },
  );
  let stderr = '';
  // Por líneas completas: una URL partida entre dos chunks no se escapa de la redacción.
  const pending = { stdout: '', stderr: '' };
  const toLog = (stream: 'stdout' | 'stderr', chunk: Buffer, flush = false) => {
    if (logFd === null) return;
    const text = pending[stream] + chunk.toString();
    const cut = flush ? text.length : text.lastIndexOf('\n') + 1;
    pending[stream] = text.slice(cut);
    if (cut > 0) writeSync(logFd, redact(text.slice(0, cut)));
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    toLog('stdout', chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    toLog('stderr', chunk);
  });
  const exited = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));
  if (logFd !== null) {
    void exited.then(() => {
      toLog('stdout', Buffer.alloc(0), true);
      toLog('stderr', Buffer.alloc(0), true);
      closeSync(logFd);
    });
  }

  // Cargar el estado del sistema (--load-state) con varios forks arrancando a la vez puede tardar.
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new AnvilExitedError(`anvil terminó al arrancar: ${redact(stderr.slice(-300))}`);
    }
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

/**
 * Espera el receipt de una tx consultando `eth_getTransactionReceipt` cada 250 ms. No usa `waitForTransactionReceipt` de
 * viem: con Anvil bajo carga en CI, su watcher de bloques llegó a no volver a pedir el receipt de una tx ya minada y
 * vencía (logs de Anvil de la corrida). Una consulta que vence o falla por HTTP mientras Anvil mina una tx que trae
 * mucho estado del fork (p. ej. un swap grande) se reintenta: lo que acota la espera es el plazo total.
 */
export async function waitForReceipt(
  client: Pick<PublicClient, 'getTransactionReceipt'>,
  hash: Hex,
  timeoutMs = 180_000,
): Promise<TransactionReceipt> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await client.getTransactionReceipt({ hash }).catch((error: unknown) => {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      if (error instanceof TimeoutError || error instanceof HttpRequestError) return null;
      throw error;
    });
    if (receipt) return receipt;
    if (Date.now() > deadline) throw new Error(`sin receipt de ${hash} en ${String(timeoutMs)} ms`);
    await sleep(250);
  }
}
