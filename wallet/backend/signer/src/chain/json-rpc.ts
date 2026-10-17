// Llamada JSON-RPC mínima con timeout (sin dependencias): la usan las guardas del provider de desarrollo y los
// health checks. Las lecturas de política usan el cliente de quórum (chain/rpc.ts).
export class JsonRpcError extends Error {
  override name = 'JsonRpcError';
  readonly rpcCode: number | undefined;

  constructor(message: string, rpcCode?: number) {
    super(message);
    this.rpcCode = rpcCode;
  }
}

export async function jsonRpc<T>(url: string, method: string, params: unknown[] = [], timeoutMs = 10_000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new JsonRpcError(`${method}: el RPC no responde`);
  }
  let body: { result?: T; error?: { code?: number; message?: string } };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new JsonRpcError(`${method}: respuesta no JSON (HTTP ${response.status})`);
  }
  if (body.error) throw new JsonRpcError(`${method}: ${body.error.message ?? 'error'}`, body.error.code);
  return body.result as T;
}
