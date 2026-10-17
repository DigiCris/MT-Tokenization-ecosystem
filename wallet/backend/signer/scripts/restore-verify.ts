// pnpm restore-verify [--shard <id>]
// Modo restore-verify [B-SIG-08]: abre el shard con la credencial montada, descifra cada keystore registrado y comprueba
// su dirección, sin firmar nada. Las claves restauradas que verifican vuelven a ACTIVE. Código 1 si algo no verifica.
import { readCredentialFile } from '../src/keystore/derive-password.ts';
import { SelfHostedSoftwareSignerProvider } from '../src/providers/SelfHostedSoftwareSignerProvider.ts';
import { args, fail, output, run, shardContext } from '../src/cli/common.ts';

await run(async () => {
  const { values } = args({ shard: { type: 'string' } });
  const ctx = shardContext({ shard: values.shard });
  try {
    const provider = await SelfHostedSoftwareSignerProvider.open({
      shardId: ctx.config.shardId,
      keystoreDir: ctx.config.keystoreDir,
      credential: readCredentialFile(ctx.config.credentialFile, { keystoreDir: ctx.config.keystoreDir }),
      db: ctx.db,
      logger: ctx.logger,
    });
    if (!provider.ready) fail(`shard no listo: ${provider.problems.join('; ')}`);
    const report = await provider.verifyAll();
    output({
      shardId: ctx.config.shardId,
      verified: report.verified.length,
      failed: report.failed,
      unexpectedFiles: report.unexpectedFiles,
    });
    if (report.failed.length > 0 || report.unexpectedFiles.length > 0) process.exitCode = 1;
  } finally {
    await ctx.close();
  }
});
