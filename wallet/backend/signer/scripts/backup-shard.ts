// pnpm shard:backup --out <archivo.age> --recipient <age1…> [--recipient <age1…>] [--shard <id>]
// Backup cifrado con age del shard (keystores + DB, sin la credencial de desbloqueo). Imprime el sha256 del archivo.
import { args, fail, output, run, shardContext } from '../src/cli/common.ts';
import { backupShard } from '../src/lifecycle/backup.ts';

await run(async () => {
  const { values } = args({
    shard: { type: 'string' },
    out: { type: 'string' },
    recipient: { type: 'string', multiple: true },
  });
  if (values.out === undefined || values.recipient === undefined)
    fail('uso: shard:backup --out <archivo> --recipient <age1…>');
  const ctx = shardContext({ shard: values.shard });
  try {
    output(
      await backupShard({
        db: ctx.db,
        shardId: ctx.config.shardId,
        keystoreDir: ctx.config.keystoreDir,
        recipients: values.recipient,
        outFile: values.out,
      }),
    );
  } finally {
    await ctx.close();
  }
});
