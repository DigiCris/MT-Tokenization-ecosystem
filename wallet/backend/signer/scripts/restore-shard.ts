// pnpm shard:restore --in <archivo.age> --identity <identidad age> [--shard <id>]
// Restore en un host nuevo: DB y directorio de keystores vacíos; después correr `pnpm restore-verify` (descifra cada
// keystore con la credencial montada y comprueba su dirección) antes de arrancar el shard.
import { readFileSync } from 'node:fs';
import { args, fail, output, run, shardContext } from '../src/cli/common.ts';
import { restoreShard } from '../src/lifecycle/backup.ts';

await run(async () => {
  const { values } = args({ shard: { type: 'string' }, in: { type: 'string' }, identity: { type: 'string' } });
  if (values.in === undefined || values.identity === undefined)
    fail('uso: shard:restore --in <archivo> --identity <archivo>');
  const ctx = shardContext({ shard: values.shard });
  try {
    output(
      await restoreShard({
        db: ctx.db,
        shardId: ctx.config.shardId,
        keystoreDir: ctx.config.keystoreDir,
        inFile: readFileSync(values.in),
        identityFile: values.identity,
      }),
    );
  } finally {
    await ctx.close();
  }
});
