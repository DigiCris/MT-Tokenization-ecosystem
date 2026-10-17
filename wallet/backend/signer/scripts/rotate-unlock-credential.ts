// pnpm credential:rotate --new-credential <archivo> [--shard <id>]
// Rotación de la credencial de desbloqueo del shard (shard detenido): re-cifra todos los keystores con la credencial
// nueva (archivo por archivo, atómico, kdfVersion + 1, reanudable). Después se monta la credencial nueva como secret,
// se reinicia el shard y se retira la anterior (docs/runbooks/signer-lifecycle.md).
import { args, fail, output, run, shardContext } from '../src/cli/common.ts';
import { readCredentialFile } from '../src/keystore/derive-password.ts';
import { rotateCredential } from '../src/lifecycle/credential.ts';

await run(async () => {
  const { values } = args({ shard: { type: 'string' }, 'new-credential': { type: 'string' } });
  if (values['new-credential'] === undefined) fail('uso: credential:rotate --new-credential <archivo>');
  const ctx = shardContext({ shard: values.shard });
  try {
    const opts = { keystoreDir: ctx.config.keystoreDir };
    output(
      await rotateCredential({
        db: ctx.db,
        shardId: ctx.config.shardId,
        keystoreDir: ctx.config.keystoreDir,
        oldCredential: readCredentialFile(ctx.config.credentialFile, opts),
        newCredential: readCredentialFile(values['new-credential'], opts),
      }),
    );
  } finally {
    await ctx.close();
  }
});
