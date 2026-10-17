// Proxy JSON-RPC de inyección de fallas (test-only, §10 "Resiliencia"): se pone delante de un Anvil real del fork y
// altera respuestas según el modo: timeout, respuesta divergente, chainId incorrecto, error HTTP o head atrasado.
import { createServer, type Server } from 'node:http';
import { freePort } from './fork.ts';

export type FaultMode =
  | { kind: 'pass' }
  /** No responde (el cliente agota su timeout). */
  | { kind: 'timeout'; methods?: string[] }
  /** Cambia el resultado de los métodos indicados (lecturas de estado). */
  | { kind: 'diverge'; methods: string[] }
  | { kind: 'wrong-chain' }
  | { kind: 'http-error'; status: number }
  /** Informa un head `lag` bloques por detrás del real. */
  | { kind: 'head-lag'; lag: number };

export interface FaultProxy {
  url: string;
  setMode: (mode: FaultMode) => void;
  requests: () => string[];
  close: () => Promise<void>;
}

interface RpcRequest {
  jsonrpc: string;
  id: unknown;
  method: string;
  params?: unknown[];
}

function flipLastHexDigit(value: string): string {
  const last = value.at(-1) ?? '0';
  return `${value.slice(0, -1)}${last === '0' ? '1' : '0'}`;
}

export async function startFaultProxy(upstream: string): Promise<FaultProxy> {
  let mode: FaultMode = { kind: 'pass' };
  const seen: string[] = [];
  const pending = new Set<() => void>();
  const port = await freePort();

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      void (async () => {
        const parsed = JSON.parse(raw) as RpcRequest | RpcRequest[];
        const batch = Array.isArray(parsed) ? parsed : [parsed];
        for (const r of batch) seen.push(r.method);
        const current = mode;

        if (current.kind === 'http-error') {
          res.writeHead(current.status).end('injected failure');
          return;
        }
        if (
          current.kind === 'timeout' &&
          (!current.methods || batch.some((r) => current.methods?.includes(r.method)))
        ) {
          // Se retiene la respuesta hasta que el proxy cierre (el cliente corta por timeout).
          pending.add(() => res.destroy());
          return;
        }
        const upstreamResponse = await fetch(upstream, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        const body = (await upstreamResponse.json()) as
          { id: unknown; result?: unknown } | { id: unknown; result?: unknown }[];
        const responses = Array.isArray(body) ? body : [body];
        for (const response of responses) {
          const request = batch.find((r) => r.id === response.id);
          const result = response.result;
          if (!request || typeof result !== 'string') continue;
          if (current.kind === 'wrong-chain' && request.method === 'eth_chainId') response.result = '0x1';
          if (current.kind === 'diverge' && current.methods.includes(request.method)) {
            response.result = flipLastHexDigit(result);
          }
          if (current.kind === 'head-lag' && request.method === 'eth_blockNumber') {
            response.result = `0x${(BigInt(result) - BigInt(current.lag)).toString(16)}`;
          }
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
      })().catch(() => {
        res.writeHead(502).end();
      });
    });
  });
  await new Promise<void>((resolveListen) => server.listen(port, '127.0.0.1', resolveListen));

  return {
    url: `http://127.0.0.1:${port}`,
    setMode: (next) => {
      mode = next;
    },
    requests: () => [...seen],
    close: async () => {
      for (const release of pending) release();
      pending.clear();
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      });
    },
  };
}
