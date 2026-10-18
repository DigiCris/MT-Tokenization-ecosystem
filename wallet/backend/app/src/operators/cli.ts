// pnpm operators <comando> [--opciones]   (CLI de operadores, P15.T06/T09; runbooks exceptional-migration.md y
// executor-key-loss.md). Corre con la configuración del backend (mismas variables y secretos que el proceso `api`).
//
//   operator:add --email <email> --name <nombre> --totp-uri-file <archivo>
//   operator:disable --email <email>
//   migration:request --wallet <id> --healthy U|R --reason <texto> --operator <email>
//   migration:approve --case <id> --operator <email>
//   migration:cancel --case <id> --operator <email>
//   migration:status --case <id>
//   executor:prepare --wallet <id> --operator <email> --out <directorio>
//   executor:activate --wallet <id> --operator <email>
//   executor:rotation-request --wallet <id> --reason SHARD_MIGRATION|HSM_MIGRATION|KEY_COMPROMISE|MAINTENANCE
//                             --operator <email> [--to-shard <id>]
//
// Las acciones con `--operator` leen el código TOTP del operador por stdin (nunca como argumento). La URI otpauth del
// alta se escribe en un archivo nuevo con permisos 0600 (nunca en la salida). La salida es una línea JSON sin secretos.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../api/errors.ts';
import { AuditWriter } from '../audit/audit-writer.ts';
import { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import { ConfigError, loadConfig, loadSignerClientConfig } from '../config/env.ts';
import { createDatabase } from '../db/kysely.ts';
import { OutboxRepository } from '../db/repositories/outbox-repository.ts';
import { EmailOutbox } from '../email/email-outbox.ts';
import { createLogger } from '../observability/logger.ts';
import { createMetrics } from '../observability/metrics.ts';
import { loadPolicySnapshot } from '../policy/snapshot.ts';
import { ExecutorReplacementService } from '../recovery/executor-replacement.ts';
import {
  EXECUTOR_ROTATION_REASONS,
  ExecutorRotationRequests,
  type ExecutorRotationReason,
} from '../rotations/executor-request.ts';
import { MigrationCases } from '../recovery/migration.ts';
import { readSignerTls, SignerClient } from '../signer-client/client.ts';
import { SignerKeyService } from '../signer-client/sharding.ts';
import { OperatorError, OperatorService, type OperatorCredentials } from './service.ts';

const COMMANDS = [
  'operator:add',
  'operator:disable',
  'migration:request',
  'migration:approve',
  'migration:cancel',
  'migration:status',
  'executor:prepare',
  'executor:activate',
  'executor:rotation-request',
] as const;
type Command = (typeof COMMANDS)[number];

class UsageError extends Error {
  override name = 'UsageError';
}

function parseArgs(argv: readonly string[]): { command: Command; flags: Map<string, string> } {
  const args = argv.filter((a) => a !== '--');
  const command = args[0];
  if (command === undefined || !(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(`comando desconocido; usá uno de: ${COMMANDS.join(', ')}`);
  }
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (key?.startsWith('--') !== true || value === undefined) throw new UsageError(`opción inválida: ${key ?? ''}`);
    flags.set(key.slice(2), value);
  }
  return { command: command as Command, flags };
}

function flag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.trim() === '') throw new UsageError(`falta --${name}`);
  return value.trim();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function credentials(flags: Map<string, string>): Promise<OperatorCredentials> {
  const totp = await readStdin();
  if (!/^\d{6}$/.test(totp)) throw new UsageError('el código TOTP del operador va por stdin (6 dígitos)');
  return { email: flag(flags, 'operator'), totp };
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const metrics = createMetrics({ defaultMetrics: false });
  const logger = createLogger({ level: 'warn', service: 'mtw-operators' });
  const db = createDatabase({ connectionString: config.database.url.reveal(), applicationName: 'mtw-operators' });
  const audit = new AuditWriter(config.secrets.auditChainKey, metrics);
  const emails = new EmailOutbox(new OutboxRepository(db), config.secrets.fieldEncryptionKey);
  const operators = new OperatorService({ db, fieldKey: config.secrets.fieldEncryptionKey, audit });
  const closers: (() => Promise<void> | void)[] = [() => db.destroy()];
  const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    if (command === 'operator:add') {
      const file = flag(flags, 'totp-uri-file');
      const added = await operators.add({ email: flag(flags, 'email'), displayName: flag(flags, 'name') });
      // `wx`: nunca pisa un archivo existente; 0600: sólo el operador que corre la CLI.
      writeFileSync(file, `${added.otpauthUri}\n`, { mode: 0o600, flag: 'wx' });
      out({ operatorId: added.operator.id, email: added.operator.email, totpUriFile: file });
      return;
    }
    if (command === 'operator:disable') {
      out(await operators.disable(flag(flags, 'email')));
      return;
    }
    if (command.startsWith('migration:')) {
      // Los comandos de operadores de la migración no consultan la cadena (el prepare es de la API).
      const migrations = new MigrationCases({ db, operators, audit, emails, metrics });
      if (command === 'migration:status') {
        out(await migrations.view(flag(flags, 'case')));
      } else if (command === 'migration:request') {
        const healthy = flag(flags, 'healthy');
        if (healthy !== 'U' && healthy !== 'R') throw new UsageError('--healthy tiene que ser U o R');
        out(
          await migrations.request({
            walletId: flag(flags, 'wallet'),
            healthyRole: healthy,
            reason: flag(flags, 'reason'),
            operator: await credentials(flags),
          }),
        );
      } else if (command === 'migration:approve') {
        out(await migrations.approve({ caseId: flag(flags, 'case'), operator: await credentials(flags) }));
      } else {
        out(await migrations.cancel({ caseId: flag(flags, 'case'), operator: await credentials(flags) }));
      }
      return;
    }
    // executor:*: shards del signer (mTLS), RPC con quórum y snapshot de policy firmado.
    const signer = loadSignerClientConfig();
    const snapshot = loadPolicySnapshot(signer.policy.snapshotPath, signer.policy.publicKey, config.appEnv);
    const rpc = new RpcQuorumClient({
      primaryUrl: config.rpc.primaryUrl.reveal(),
      secondaryUrl: config.rpc.secondaryUrl.reveal(),
      mode: config.rpc.quorumMode,
      chainId: config.chainId,
      timeoutMs: config.rpc.timeoutMs,
      healthIntervalMs: config.rpc.healthIntervalMs,
      maxHeadLagBlocks: config.rpc.maxHeadLagBlocks,
      retries: config.rpc.quorumRetries,
      backoffMs: config.rpc.quorumBackoffMs,
      logger,
      metrics,
    });
    const tls = readSignerTls(signer.mtls);
    const clients = new Map(
      signer.shards.map((s) => [
        s.id,
        new SignerClient({ shardId: s.id, url: s.url, tls, timeoutMs: signer.timeoutMs }),
      ]),
    );
    closers.push(() => {
      for (const client of clients.values()) client.close();
    });
    const signerKeys = new SignerKeyService({ db, shards: signer.shards, clients });
    if (command === 'executor:rotation-request') {
      // P18.T09.b: borrador de rotación de S con el motivo; la propuesta la firma el usuario desde su app.
      const reason = flag(flags, 'reason');
      if (!(EXECUTOR_ROTATION_REASONS as readonly string[]).includes(reason)) {
        throw new UsageError(`--reason tiene que ser uno de: ${EXECUTOR_ROTATION_REASONS.join(', ')}`);
      }
      const requests = new ExecutorRotationRequests({
        db,
        operators,
        signerKeys,
        rpc,
        snapshot: () => snapshot,
        audit,
        emails,
        metrics,
      });
      const toShard = flags.get('to-shard')?.trim();
      out(
        await requests.request({
          walletId: flag(flags, 'wallet'),
          reason: reason as ExecutorRotationReason,
          ...(toShard === undefined || toShard === '' ? {} : { toShard }),
          operator: await credentials(flags),
        }),
      );
      return;
    }
    const service = new ExecutorReplacementService({
      db,
      operators,
      signerKeys,
      rpc,
      snapshot: () => snapshot,
      audit,
      emails,
      metrics,
    });
    if (command === 'executor:prepare') {
      const dir = flag(flags, 'out');
      const plan = await service.prepare({ walletId: flag(flags, 'wallet'), operator: await credentials(flags) });
      const files = plan.documents.map((doc, i) => {
        const file = join(dir, `${plan.walletId}-${String(i + 1)}-${doc.action.type.toLowerCase()}.json`);
        writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { flag: 'wx' });
        return file;
      });
      out({
        walletId: plan.walletId,
        safe: plan.safe,
        oldExecutor: plan.oldExecutor,
        newExecutor: plan.newExecutor,
        shardId: plan.shardId,
        attestation: plan.attestation,
        documents: files,
      });
    } else {
      out(await service.activate({ walletId: flag(flags, 'wallet'), operator: await credentials(flags) }));
    }
  } finally {
    for (const close of closers.reverse()) await close();
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof ApiError
      ? `${error.code}${error.detail === undefined ? '' : `: ${error.detail}`}`
      : error instanceof OperatorError
        ? error.code
        : error instanceof UsageError || error instanceof ConfigError
          ? error.message
          : 'error inesperado';
  process.stderr.write(`operators: ${message}\n`);
  process.exit(1);
});
