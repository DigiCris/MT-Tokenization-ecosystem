// Proxy TCP de inyección de fallas (test-only): delante de un servicio real (p. ej. el SMTP de Mailpit o un shard del
// signer por mTLS, que pasa cifrado de punta a punta) deja pasar las conexiones, las corta apenas se abren o retiene las
// respuestas del servidor hasta liberarlas (el cliente queda esperando como ante un proceso pausado o una red lenta).
import { connect, createServer, type Socket } from 'node:net';

export type TcpProxyMode = 'pass' | 'refuse' | 'hold';

export interface TcpProxy {
  host: string;
  port: number;
  setMode: (mode: TcpProxyMode) => void;
  /** Entrega las respuestas retenidas y vuelve a dejar pasar. */
  release: () => void;
  /** Bytes de respuesta retenidos hasta ahora. */
  heldBytes: () => number;
  /** Conexiones recibidas (aceptadas o cortadas). */
  connections: () => number;
  close: () => Promise<void>;
}

export async function startTcpProxy(target: { host: string; port: number }): Promise<TcpProxy> {
  let mode: TcpProxyMode = 'pass';
  let count = 0;
  const open = new Set<Socket>();
  const held: { client: Socket; chunk: Buffer }[] = [];
  const server = createServer((client) => {
    count += 1;
    open.add(client);
    client.on('close', () => open.delete(client));
    client.on('error', () => undefined);
    if (mode === 'refuse') {
      client.destroy();
      return;
    }
    const upstream = connect(target.port, target.host);
    open.add(upstream);
    upstream.on('close', () => open.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.pipe(upstream);
    upstream.on('data', (chunk: Buffer) => {
      if (mode === 'hold') held.push({ client, chunk });
      else client.write(chunk);
    });
    upstream.on('end', () => {
      if (mode !== 'hold') client.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('proxy sin puerto');
  return {
    host: '127.0.0.1',
    port: address.port,
    setMode: (next) => {
      mode = next;
    },
    release: () => {
      mode = 'pass';
      for (const { client, chunk } of held.splice(0)) if (!client.destroyed) client.write(chunk);
    },
    heldBytes: () => held.reduce((n, h) => n + h.chunk.length, 0),
    connections: () => count,
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
