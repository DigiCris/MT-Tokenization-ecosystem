// Proxy TCP de inyección de fallas (test-only): delante de un servicio real (p. ej. el SMTP de Mailpit) deja pasar las
// conexiones o las corta apenas se abren, para probar reintentos ante una caída real del servidor.
import { connect, createServer, type Socket } from 'node:net';

export interface TcpProxy {
  host: string;
  port: number;
  setMode: (mode: 'pass' | 'refuse') => void;
  /** Conexiones recibidas (aceptadas o cortadas). */
  connections: () => number;
  close: () => Promise<void>;
}

export async function startTcpProxy(target: { host: string; port: number }): Promise<TcpProxy> {
  let mode: 'pass' | 'refuse' = 'pass';
  let count = 0;
  const open = new Set<Socket>();
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
    client.pipe(upstream).pipe(client);
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
