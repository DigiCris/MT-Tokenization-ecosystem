// Proxy JSON-RPC de inyección de fallas (test-only, estrategia de testing §10 "Resiliencia"): se pone delante de un
// Anvil real y altera las respuestas según el modo (timeout, resultado divergente o mal formado, error HTTP, head
// atrasado, error JSON-RPC del nodo).
import { createServer, type Server } from 'node:http';
import { freePort } from './anvil.ts';

export type FaultMode =
  | { kind: 'pass' }
  /** No responde (el cliente agota su timeout). */
  | { kind: 'timeout' }
  /** Cambia el resultado de los métodos indicados. */
  | { kind: 'diverge'; methods: string[] }
  /** Devuelve un resultado mal formado (no hexadecimal) en los métodos indicados. */
  | { kind: 'malformed'; methods: string[] }
  /** Responde con un error HTTP y un cuerpo que no es JSON. */
  | { kind: 'http-error'; status: number }
  /** Informa un head `lag` bloques por detrás del real. */
  | { kind: 'head-lag'; lag: number }
  /** Responde un error JSON-RPC del nodo (no un revert) en los métodos indicados. */
  | { kind: 'rpc-error'; methods: string[]; code: number; message: string };

export interface FaultProxy {
  url: string;
  setMode: (mode: FaultMode) => void;
  close: () => Promise<void>;
}

interface RpcRequest {
  id: unknown;
  method: string;
}

function flipLastHexDigit(value: string): string {
  const last = value.at(-1) ?? '0';
  return `${value.slice(0, -1)}${last === '0' ? '1' : '0'}`;
}

export async function startFaultProxy(upstream: string): Promise<FaultProxy> {
  let mode: FaultMode = { kind: 'pass' };
  const held = new Set<() => void>();
  const port = await freePort();

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      void (async () => {
        const request = JSON.parse(raw) as RpcRequest;
        const current = mode;
        if (current.kind === 'http-error') {
          res.writeHead(current.status).end('injected failure');
          return;
        }
        if (current.kind === 'rpc-error' && current.methods.includes(request.method)) {
          const error = { code: current.code, message: current.message };
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error }));
          return;
        }
        if (current.kind === 'timeout') {
          // Se retiene la respuesta hasta que el proxy cierre (el cliente corta por timeout).
          held.add(() => res.destroy());
          return;
        }
        const upstreamResponse = await fetch(upstream, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        const body = (await upstreamResponse.json()) as { result?: unknown };
        const result = body.result;
        if (typeof result === 'string') {
          if (current.kind === 'diverge' && current.methods.includes(request.method)) {
            body.result = flipLastHexDigit(result);
          }
          if (current.kind === 'malformed' && current.methods.includes(request.method)) body.result = 'not-hex';
          if (current.kind === 'head-lag' && request.method === 'eth_blockNumber') {
            body.result = `0x${(BigInt(result) - BigInt(current.lag)).toString(16)}`;
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
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
    close: async () => {
      for (const release of held) release();
      held.clear();
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      });
    },
  };
}
