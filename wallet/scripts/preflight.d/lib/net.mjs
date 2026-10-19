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

// Rate limit o saturación momentánea del proveedor (p. ej. muchos jobs de CI contra el mismo RPC a la vez).
const RETRYABLE_STATUS = new Set([429, 503]);
const MAX_RETRY_AFTER_MS = 10_000;

/** Espera antes de reintentar: Retry-After en segundos (con tope) o backoff exponencial con jitter. */
export function retryDelayMs(retryAfter, attempt, baseMs = 500) {
  const seconds = Number(retryAfter);
  if (retryAfter !== null && retryAfter !== '' && Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return baseMs * 2 ** attempt + Math.floor(Math.random() * baseMs);
}

/**
 * JSON-RPC; devuelve { result, ms }. Lanza RpcError sin exponer la URL completa. Un 429/503 se reintenta hasta
 * `retries` veces con backoff; `ms` es la latencia del intento que respondió (no incluye las esperas).
 */
export async function rpc(url, method, params = [], timeoutMs = 20000, headers = {}, { retries = 4, baseMs = 500 } = {}) {
  for (let attempt = 0; ; attempt++) {
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
    if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, retryDelayMs(res.headers.get('retry-after'), attempt, baseMs)));
      continue;
    }
    return parseRpcResponse(res, url, method, ms, attempt);
  }
}

async function parseRpcResponse(res, url, method, ms, attempt) {
  const retried = attempt > 0 ? ` tras ${attempt + 1} intentos` : '';
  if (!res.ok) throw new RpcError(`${method} → HTTP ${res.status} de ${hostOf(url)}${retried}`);
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
