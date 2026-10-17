// Cliente mínimo RESP (Valkey/Redis) para el preflight: AUTH + comandos simples. Sin dependencias.
import net from 'node:net';

function encode(args) {
  return `*${args.length}\r\n` + args.map((a) => `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`).join('');
}

// Parser incremental de una respuesta RESP2/RESP3 básica; devuelve [valor, resto] o null si incompleta.
function parse(buf) {
  if (!buf.length) return null;
  const nl = buf.indexOf('\r\n');
  if (nl < 0) return null;
  const t = buf[0];
  const line = buf.slice(1, nl);
  const rest = buf.slice(nl + 2);
  if (t === '+' ) return [line, rest];
  if (t === '-') return [new Error(line), rest];
  if (t === ':') return [Number(line), rest];
  if (t === '$') {
    const n = Number(line);
    if (n < 0) return [null, rest];
    if (rest.length < n + 2) return null;
    return [rest.slice(0, n), rest.slice(n + 2)];
  }
  if (t === '*') {
    const n = Number(line);
    let r = rest;
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = parse(r);
      if (!p) return null;
      out.push(p[0]);
      r = p[1];
    }
    return [out, r];
  }
  throw new Error('respuesta RESP no soportada');
}

/** Ejecuta comandos en orden ([["PING"], ["CONFIG","GET","x"]]) y devuelve sus respuestas. */
export function respCommands(url, commands, timeoutMs = 5000) {
  const u = new URL(url);
  if (!/^rediss?:$/.test(u.protocol)) throw new Error('REDIS_URL debe ser redis://');
  const password = decodeURIComponent(u.password);
  const all = (password ? [['AUTH', password]] : []).concat(commands);
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: u.hostname || '127.0.0.1', port: Number(u.port || 6379) });
    let buf = '';
    const replies = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('timeout conectando a Valkey'));
    }, timeoutMs);
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Valkey no responde (${e.code ?? e.message})`));
    });
    sock.once('connect', () => sock.write(all.map(encode).join('')));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let p;
      while ((p = parse(buf))) {
        replies.push(p[0]);
        buf = p[1];
      }
      if (replies.length === all.length) {
        clearTimeout(timer);
        sock.end();
        const out = password ? replies.slice(1) : replies;
        if (password && replies[0] instanceof Error) return reject(new Error('Valkey rechazó la autenticación'));
        resolve(out);
      }
    });
  });
}
