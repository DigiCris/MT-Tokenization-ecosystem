// Entrypoint del signer-service. Comandos:
//   serve [--shard <id>]           arranca el shard (API mTLS)
//   migrate [--shard <id>]         aplica las migraciones de la DB del shard
//   restore-verify [--shard <id>]  descifra cada keystore y comprueba su dirección, sin firmar ([B-SIG-08])
// En local, `--shard platform` levanta la cuenta gas tank con sus variables SIGNER_PLATFORM_*.
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './config/env.ts';
import { createLogger } from './observability/logger.ts';
import { openProvider, StartupError, startSigner } from './runtime.ts';
import { createSignerDb } from './state/db.ts';
import { migrateToLatest } from './state/migrator.ts';

function fail(message: string): never {
  process.stderr.write(`signer: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { shard: { type: 'string' } },
    args: process.argv.slice(2).filter((a) => a !== '--'),
  });
  const command = positionals[0] ?? 'serve';
  let config;
  try {
    config = loadConfig(values.shard === undefined ? {} : { shard: values.shard });
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }
  const logger = createLogger({ level: config.logLevel, service: 'signer', shardId: config.shardId });
  switch (command) {
    case 'serve': {
      const runtime = await startSigner(config, { logger });
      const stop = () => {
        void runtime.close().then(() => process.exit(0));
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      return;
    }
    case 'migrate': {
      const db = createSignerDb({
        connectionString: config.databaseUrl.reveal(),
        applicationName: 'mtw-signer-migrate',
      });
      try {
        const applied = await migrateToLatest(db);
        process.stdout.write(
          `migraciones aplicadas: ${applied.length > 0 ? applied.join(', ') : 'ninguna (al día)'}\n`,
        );
      } finally {
        await db.destroy();
      }
      return;
    }
    case 'restore-verify': {
      const db = createSignerDb({
        connectionString: config.databaseUrl.reveal(),
        applicationName: 'mtw-signer-restore-verify',
      });
      try {
        const provider = await openProvider(config, db, logger, undefined, undefined);
        if (!provider.ready) fail(`shard no listo: ${provider.problems.join('; ')}`);
        const report = await provider.verifyAll();
        process.stdout.write(
          `${JSON.stringify({ shardId: config.shardId, verified: report.verified.length, failed: report.failed, unexpectedFiles: report.unexpectedFiles })}\n`,
        );
        if (report.failed.length > 0 || report.unexpectedFiles.length > 0) process.exitCode = 1;
      } finally {
        await db.destroy();
      }
      return;
    }
    default:
      fail(`comando desconocido: ${command} (serve | migrate | restore-verify)`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof StartupError || error instanceof ConfigError) fail(error.message);
  fail(error instanceof Error ? `${error.name}: ${error.message}` : 'error desconocido');
});
