// pnpm shard:create [--shard <id>] [--generate-credential] [--gas-tank]
// Alta de un shard (P11.T10, docs/runbooks/signer-lifecycle.md): migra su DB, verifica el directorio de keystores
// (0700, vacío), genera la credencial si se pide (en otro directorio), registra el fingerprint y, con --gas-tank, crea
// la cuenta gas tank del shard `platform`. Imprime el fingerprint y la dirección del gas tank (nunca la credencial).
import { args, output, run, shardContext } from '../src/cli/common.ts';
import { createShard } from '../src/lifecycle/shard.ts';

await run(async () => {
  const { values } = args({
    shard: { type: 'string' },
    'generate-credential': { type: 'boolean', default: false },
    'gas-tank': { type: 'boolean', default: false },
  });
  const ctx = shardContext({ shard: values.shard });
  try {
    const result = await createShard({
      db: ctx.db,
      shardId: ctx.config.shardId,
      provider: ctx.config.provider,
      keystoreDir: ctx.config.keystoreDir,
      credentialFile: ctx.config.credentialFile,
      generateCredential: values['generate-credential'],
      gasTank: values['gas-tank'] || ctx.config.shardId === 'platform',
      logger: ctx.logger,
    });
    output({ shardId: ctx.config.shardId, ...result });
  } finally {
    await ctx.close();
  }
});
