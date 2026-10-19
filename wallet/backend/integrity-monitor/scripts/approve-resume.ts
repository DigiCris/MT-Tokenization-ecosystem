// Aprobación de reanudación de un operador (P20.T04, runbook docs/runbooks/integrity-mismatch.md): firma con la clave
// Ed25519 propia del operador (archivo PEM o PKCS#8 DER, nunca un argumento) la reanudación de un release exacto y la
// envía al monitor (o la escribe por stdout con --print). Hacen falta dos operadores distintos.
//
//   pnpm resume:approve --operator <id> --key-file <archivo> --app WALLET|RECOVERY --release <releaseId>
//                       --manifest-sha256 0x<hex> --platform <platformId> --environment local|staging|production
//                       (--monitor <url> | --print)
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { signApproval } from '../src/approvals.ts';
import { privateKeyFrom } from '../src/config.ts';

const { values } = parseArgs({
  options: {
    operator: { type: 'string' },
    'key-file': { type: 'string' },
    app: { type: 'string' },
    release: { type: 'string' },
    'manifest-sha256': { type: 'string' },
    platform: { type: 'string' },
    environment: { type: 'string' },
    monitor: { type: 'string' },
    print: { type: 'boolean' },
  },
});
const missing = ['operator', 'key-file', 'app', 'release', 'manifest-sha256', 'platform', 'environment'].filter(
  (name) => values[name as keyof typeof values] === undefined,
);
if (missing.length > 0 || (values.monitor === undefined && values.print !== true)) {
  process.stderr.write(
    `faltan: ${[...missing, ...(values.monitor || values.print ? [] : ['--monitor o --print'])].join(', ')}\n`,
  );
  process.exit(2);
}
const app = values.app;
if (app !== 'WALLET' && app !== 'RECOVERY') {
  process.stderr.write('--app tiene que ser WALLET o RECOVERY\n');
  process.exit(2);
}
const approval = signApproval(
  {
    operatorId: values.operator ?? '',
    app,
    releaseId: values.release ?? '',
    manifestSha256: values['manifest-sha256'] ?? '',
    issuedAt: Math.floor(Date.now() / 1000),
  },
  { platformId: values.platform ?? '', environment: values.environment ?? '' },
  privateKeyFrom(readFileSync(values['key-file'] ?? '', 'utf8'), '--key-file'),
);
if (values.print === true) {
  process.stdout.write(`${JSON.stringify(approval)}\n`);
} else {
  const response = await fetch(`${(values.monitor ?? '').replace(/\/+$/, '')}/v1/resume-approvals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(approval),
  });
  process.stdout.write(`${JSON.stringify({ status: response.status, response: await response.json() })}\n`);
  if (!response.ok) process.exit(1);
}
