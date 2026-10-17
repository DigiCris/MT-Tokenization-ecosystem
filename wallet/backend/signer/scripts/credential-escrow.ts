// Custodia offline de la credencial de desbloqueo (dos copias selladas, custodios distintos):
//   pnpm credential:escrow --out-dir <dir> --custodian <nombre>=<age1…> --custodian <nombre>=<age1…> [--shard <id>]
//   pnpm credential:escrow --recover <copia.age> --identity <identidad age> --out <archivo> [--shard <id>]
import { args, fail, output, run, shardContext } from '../src/cli/common.ts';
import { escrowCredential, recoverCredential } from '../src/lifecycle/credential.ts';

await run(async () => {
  const { values } = args({
    shard: { type: 'string' },
    'out-dir': { type: 'string' },
    custodian: { type: 'string', multiple: true },
    recover: { type: 'string' },
    identity: { type: 'string' },
    out: { type: 'string' },
  });
  const ctx = shardContext({ shard: values.shard });
  try {
    if (values.recover !== undefined) {
      if (values.identity === undefined || values.out === undefined)
        fail('uso: --recover <copia> --identity <archivo> --out <archivo>');
      await recoverCredential({
        db: ctx.db,
        shardId: ctx.config.shardId,
        sealedFile: values.recover,
        identityFile: values.identity,
        outFile: values.out,
      });
      output({ recovered: true, shardId: ctx.config.shardId });
      return;
    }
    if (values['out-dir'] === undefined || values.custodian === undefined)
      fail('uso: --out-dir <dir> --custodian <nombre>=<age1…> (dos veces)');
    const custodians = values.custodian.map((c) => {
      const [name = '', recipient = ''] = c.split('=');
      return { name, recipient };
    });
    output(
      await escrowCredential({
        db: ctx.db,
        shardId: ctx.config.shardId,
        credentialFile: ctx.config.credentialFile,
        keystoreDir: ctx.config.keystoreDir,
        custodians,
        outDir: values['out-dir'],
      }),
    );
  } finally {
    await ctx.close();
  }
});
