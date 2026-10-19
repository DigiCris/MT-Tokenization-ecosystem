// CLI de operadores del backend (`node src/operators/cli.ts`) contra el stack: misma base y mismos secretos (el .env del
// stack), el TOTP del operador por stdin y la URI otpauth del alta en un archivo 0600 nuevo, como en producción.
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stack } from './stack.ts';

const BACKEND = resolve(import.meta.dirname, '../../../../../../backend/app');

function base32(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error('secreto TOTP inválido');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** TOTP RFC 6238 (SHA-1, 6 dígitos, 30 s): lo que daría la app de autenticación del operador. */
function totp(secret: string, now: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const mac = createHmac('sha1', base32(secret)).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Un código de un paso distinto del último usado (el backend rechaza el replay del mismo paso). */
async function freshTotp(secret: string, used: Set<string>): Promise<string> {
  for (;;) {
    const code = totp(secret);
    if (!used.has(code)) {
      used.add(code);
      return code;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
}

function run(args: readonly string[], stdin = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['src/operators/cli.ts', ...args], {
      cwd: BACKEND,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, APP_ENV: 'local', MTW_ENV_FILE: stack().envFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('exit', (code) => {
      resolveRun({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

export interface StackOperator {
  email: string;
  /** Corre un comando con el TOTP del operador por stdin y devuelve el JSON de la salida. */
  command: (args: readonly string[]) => Promise<unknown>;
}

export async function addOperator(label: string): Promise<StackOperator> {
  const dir = mkdtempSync(join(tmpdir(), 'mtw-recovery-operator-'));
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@ops.mtw-browser.test`;
  try {
    const file = join(dir, 'totp-uri');
    const added = await run(['operator:add', '--email', email, '--name', label, '--totp-uri-file', file]);
    if (added.code !== 0) throw new Error(`operator:add falló: ${added.stderr}`);
    const secret = new URL(readFileSync(file, 'utf8').trim()).searchParams.get('secret') ?? '';
    const used = new Set<string>();
    return {
      email,
      command: async (args) => {
        // El código se calcula antes de lanzar la CLI y se verifica cuando ya arrancó y se conectó a la base: con la
        // máquina muy cargada eso puede pasar la ventana de ±30 s (TOTP_INVALID, sin efectos: la autenticación va
        // primero). Se reintenta con un código nuevo, sólo ante ese error y como mucho dos veces.
        for (let attempt = 1; ; attempt++) {
          const result = await run([...args, '--operator', email], await freshTotp(secret, used));
          if (result.code === 0) return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as unknown;
          if (attempt >= 3 || !result.stderr.includes('TOTP_INVALID')) {
            throw new Error(`${args[0] ?? ''} falló: ${result.stderr}`);
          }
        }
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
