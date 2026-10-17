// Utilidades de red sin dependencias: fetch con timeout, JSON-RPC, chequeo de puertos.
// Nunca incluye URLs con credenciales en mensajes de error (se reporta sólo el host).
import net from 'node:net';

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '(URL inválida)';
  }
}

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal, redirect: opts.redirect ?? 'follow' });
  } finally {
    clearTimeout(t);
  }
}

export class RpcError extends Error {}

/** JSON-RPC; devuelve { result, ms }. Lanza RpcError sin exponer la URL completa. */
export async function rpc(url, method, params = [], timeoutMs = 20000, headers = {}) {
  const t0 = performance.now();
  let res;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      },
      timeoutMs,
    );
  } catch (e) {
    throw new RpcError(`${method} → sin respuesta de ${hostOf(url)} (${e.name === 'AbortError' ? 'timeout' : e.code ?? e.message})`);
  }
  const ms = performance.now() - t0;
  if (!res.ok) throw new RpcError(`${method} → HTTP ${res.status} de ${hostOf(url)}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new RpcError(`${method} → respuesta no JSON de ${hostOf(url)}`);
  }
  if (body.error) throw new RpcError(`${method} → error RPC ${body.error.code ?? ''} ${String(body.error.message ?? '').slice(0, 120)}`);
  return { result: body.result, ms };
}

/** true si algo acepta conexiones TCP en 127.0.0.1:port. */
export function isPortListening(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Lee la primera línea (banner) de un servicio TCP (p. ej. SMTP "220 ..."). */
export function readBanner(port, host = '127.0.0.1', timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ port, host });
    let buf = '';
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      reject(new Error('timeout'));
    });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.includes('\n')) {
        sock.end('QUIT\r\n');
        resolve(buf.split('\n')[0].trim());
      }
    });
    sock.once('error', reject);
  });
}
