// P20.T02.a: el chequeo off-host como proceso real (`node src/main.ts check-once`, lo que corre el workflow programado):
// con las apps intactas sale 0 sin alertar; con un archivo alterado reporta MISMATCH, manda la alerta por webhook (con
// la app, el estado y el problema, sin credenciales) y sale 1. También el texto de la alerta y el envío por Mailgun.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { alertChannels, alertText, sendAlert } from '../src/notify.ts';
import { startSite, type TestSite } from './helpers/site.ts';

let wallet: TestSite;
let recovery: TestSite;

beforeEach(async () => {
  wallet = await startSite({ app: 'wallet', environment: 'production' });
  recovery = await startSite({ app: 'recovery', environment: 'production' });
});

afterEach(async () => {
  await wallet.close();
  await recovery.close();
});

async function receiver() {
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('sin puerto');
  return {
    url: `http://127.0.0.1:${String(address.port)}/hook`,
    received,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}

function checkOnce(extra: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const key = (site: TestSite) => site.releaseKey.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return new Promise((resolve) => {
    const child = spawn('node', ['src/main.ts', 'check-once'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        PATH: process.env.PATH,
        APP_ENV: 'local',
        MONITOR_MANIFEST_ENVIRONMENT: 'production',
        MONITOR_TARGETS: `WALLET=${wallet.url},RECOVERY=${recovery.url}`,
        WALLET_RELEASE_PUBLIC_KEY: key(wallet),
        RECOVERY_RELEASE_PUBLIC_KEY: key(recovery),
        ...extra,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('exit', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

it('apps intactas: sale 0 y no alerta', async () => {
  const hook = await receiver();
  const result = await checkOnce({ ALERT_WEBHOOK_URL: hook.url });
  expect(result.code).toBe(0);
  const report = JSON.parse(result.stdout) as { results: { app: string; status: string }[] };
  expect(report.results.map((r) => [r.app, r.status])).toEqual([
    ['WALLET', 'OK'],
    ['RECOVERY', 'OK'],
  ]);
  expect(hook.received).toEqual([]);
  await hook.close();
});

it('un archivo alterado: MISMATCH, alerta por webhook y salida 1', async () => {
  const hook = await receiver();
  recovery.write('assets/index-a1.js', 'alert("comprometido")');
  const result = await checkOnce({ ALERT_WEBHOOK_URL: hook.url, ALERT_SOURCE: 'test off-host' });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('integridad: alerta enviada por webhook');
  expect(hook.received).toEqual([
    {
      subject: '[MT Wallet] Integridad: RECOVERY MISMATCH (test off-host)',
      text: expect.stringContaining('assets/index-a1.js: el contenido no coincide con el manifest') as unknown,
    },
  ]);
  await hook.close();
});

it('sin configuración completa sale 2 con el motivo', async () => {
  const result = await checkOnce({ RECOVERY_RELEASE_PUBLIC_KEY: '' });
  expect(result.code).toBe(2);
  expect(result.stderr).toContain('configuración: falta RECOVERY_RELEASE_PUBLIC_KEY');
});

it('alerta por Mailgun: el pedido lleva el asunto y el texto, autenticado con la key del dominio', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response('{"id":"<x@mtw>"}', { status: 200 }));
  }) as unknown as typeof fetch;
  const channels = alertChannels({
    EMAIL_PROVIDER_API_KEY: 'key-de-prueba',
    EMAIL_PROVIDER_DOMAIN: 'sandbox.mtw.test',
    ALERT_EMAIL_TO: 'alertas@mtw.test',
  });
  const message = alertText(
    [
      { app: 'WALLET', status: 'OK', releaseId: 'w', manifestSha256: null, problems: [], files: 3 },
      {
        app: 'RECOVERY',
        status: 'UNREACHABLE',
        releaseId: null,
        manifestSha256: null,
        problems: ['/: sin respuesta'],
        files: 0,
      },
    ],
    'test',
  );
  expect(message.subject).toBe('[MT Wallet] Integridad: RECOVERY UNREACHABLE (test)');
  expect(await sendAlert(channels, message, fakeFetch)).toEqual(['email']);
  expect(calls[0]?.url).toBe('https://api.mailgun.net/v3/sandbox.mtw.test/messages');
  const body = calls[0]?.init.body as URLSearchParams;
  expect(body.get('to')).toBe('alertas@mtw.test');
  expect(body.get('text')).toContain('RECOVERY: UNREACHABLE');
  expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe(
    `Basic ${Buffer.from('api:key-de-prueba').toString('base64')}`,
  );
  expect(alertChannels({})).toEqual({});
});
