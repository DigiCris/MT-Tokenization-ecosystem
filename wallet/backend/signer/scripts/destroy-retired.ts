// pnpm shard:destroy-retired [--now <ISO-8601>] [--shard <id>]
// Destruye los keystores de claves RETIRED cuya retención de 30 días venció y que no tienen SafeTx activas firmadas.
import { args, output, run, shardContext } from '../src/cli/common.ts';
import { destroyRetired } from '../src/lifecycle/retire.ts';

await run(async () => {
  const { values } = args({ shard: { type: 'string' }, now: { type: 'string' } });
  const ctx = shardContext({ shard: values.shard });
  try {
    output(
      await destroyRetired({
        db: ctx.db,
        shardId: ctx.config.shardId,
        keystoreDir: ctx.config.keystoreDir,
        ...(values.now === undefined ? {} : { now: new Date(values.now) }),
      }),
    );
  } finally {
    await ctx.close();
  }
});
