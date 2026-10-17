// Ejecución de procesos para el preflight. Captura stdout/stderr; nunca hereda la salida (para no filtrar valores).
import { spawn, spawnSync } from 'node:child_process';

/** Ejecuta un comando y devuelve {code, stdout, stderr}. No lanza por código ≠ 0. */
export function run(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeoutMs ?? 120000, env: opts.env ?? process.env, cwd: opts.cwd, input: opts.input });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/** Variante async (para comandos largos: docker pull, bootstrap). Deja ver la salida si `inherit`. */
export function runAsync(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, cwd: opts.cwd, stdio: opts.inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs) : null;
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: String(e.message) }));
  });
}

export const which = (cmd) => run('bash', ['-c', `command -v ${JSON.stringify(cmd).slice(1, -1)}`]).stdout.trim() || null;

/** Compara versiones numéricas x.y.z: true si a >= b. */
export function versionGte(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return true;
}
