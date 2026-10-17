// Cliente mínimo de PostgreSQL (protocolo v3) para el preflight: conecta, autentica con
// SCRAM-SHA-256 (o password en claro si el server lo pide sobre localhost) y ejecuta una consulta simple.
// Sin dependencias. No registra la password ni la URL.
import net from 'node:net';
import { randomBytes, createHmac, createHash, pbkdf2Sync, timingSafeEqual } from 'node:crypto';

function parseUrl(url) {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('DATABASE_URL debe ser postgres://');
  return {
    host: u.hostname || '127.0.0.1',
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)) || decodeURIComponent(u.username),
  };
}

const int32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const msg = (type, body) => Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
const cstr = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const sha256 = (data) => createHash('sha256').update(data).digest();
const xor = (a, b) => Buffer.from(a.map((v, i) => v ^ b[i]));

/** Ejecuta `sql` (consulta simple) y devuelve las filas como arrays de strings. */
export function pgQuery(url, sql, timeoutMs = 8000) {
  const cfg = parseUrl(url);
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: cfg.host, port: cfg.port });
    let buf = Buffer.alloc(0);
    const rows = [];
    let scram = null;
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('timeout conectando a PostgreSQL')), timeoutMs);
    sock.once('error', (e) => finish(new Error(`PostgreSQL no responde (${e.code ?? e.message})`)));
    sock.once('connect', () => {
      const body = Buffer.concat([int32(196608), cstr('user'), cstr(cfg.user), cstr('database'), cstr(cfg.database), cstr('client_encoding'), cstr('UTF8'), Buffer.from([0])]);
      sock.write(Buffer.concat([int32(body.length + 4), body]));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 5) {
        const type = String.fromCharCode(buf[0]);
        const len = buf.readInt32BE(1);
        if (buf.length < len + 1) break;
        const payload = buf.subarray(5, len + 1);
        buf = buf.subarray(len + 1);
        try {
          handle(type, payload);
        } catch (e) {
          finish(e);
          return;
        }
      }
    });
    function handle(type, p) {
      if (type === 'R') {
        const code = p.readInt32BE(0);
        if (code === 0) return; // AuthenticationOk
        if (code === 3) return sock.write(msg('p', cstr(cfg.password))); // cleartext
        if (code === 10) {
          const mechs = p.subarray(4).toString('utf8').split('\0');
          if (!mechs.includes('SCRAM-SHA-256')) throw new Error('el servidor no ofrece SCRAM-SHA-256');
          const nonce = randomBytes(18).toString('base64');
          const clientFirstBare = `n=,r=${nonce}`;
          scram = { nonce, clientFirstBare };
          const data = Buffer.from(`n,,${clientFirstBare}`);
          return sock.write(msg('p', Buffer.concat([cstr('SCRAM-SHA-256'), int32(data.length), data])));
        }
        if (code === 11) {
          const serverFirst = p.subarray(4).toString('utf8');
          const attrs = Object.fromEntries(serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)]));
          if (!attrs.r?.startsWith(scram.nonce)) throw new Error('nonce SCRAM inválido');
          const salted = pbkdf2Sync(cfg.password.normalize('NFKC'), Buffer.from(attrs.s, 'base64'), Number(attrs.i), 32, 'sha256');
          const clientKey = hmac(salted, 'Client Key');
          const storedKey = sha256(clientKey);
          const clientFinalNoProof = `c=biws,r=${attrs.r}`;
          const authMessage = `${scram.clientFirstBare},${serverFirst},${clientFinalNoProof}`;
          const proof = xor(clientKey, hmac(storedKey, authMessage)).toString('base64');
          scram.serverSignature = hmac(hmac(salted, 'Server Key'), authMessage);
          return sock.write(msg('p', Buffer.from(`${clientFinalNoProof},p=${proof}`)));
        }
        if (code === 12) {
          const v = Buffer.from(p.subarray(4).toString('utf8').replace(/^v=/, ''), 'base64');
          if (v.length !== 32 || !timingSafeEqual(v, scram.serverSignature)) throw new Error('firma SCRAM del servidor inválida');
          return;
        }
        throw new Error(`método de autenticación no soportado (${code})`);
      }
      if (type === 'E') {
        const fields = Object.fromEntries(p.toString('utf8').split('\0').filter(Boolean).map((f) => [f[0], f.slice(1)]));
        throw new Error(`PostgreSQL: ${fields.C ?? ''} ${fields.M ?? 'error'}`);
      }
      if (type === 'Z') {
        if (!scram?.queried) {
          scram = { ...(scram ?? {}), queried: true };
          sock.write(msg('Q', cstr(sql)));
        } else {
          sock.write(msg('X', Buffer.alloc(0)));
          finish(null, rows);
        }
        return;
      }
      if (type === 'D') {
        const n = p.readInt16BE(0);
        let off = 2;
        const row = [];
        for (let i = 0; i < n; i++) {
          const l = p.readInt32BE(off);
          off += 4;
          if (l === -1) row.push(null);
          else {
            row.push(p.subarray(off, off + l).toString('utf8'));
            off += l;
          }
        }
        rows.push(row);
      }
    }
  });
}
