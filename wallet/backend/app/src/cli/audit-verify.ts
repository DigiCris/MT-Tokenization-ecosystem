// `pnpm audit:verify` [B-AUD]: recalcula la cadena HMAC completa de audit_events. Sale con 0 si está íntegra y con 1
// si algún eslabón no coincide (informa el id, nunca el contenido).
import { verifyAuditChain } from '../audit/audit-writer.ts';
import { loadAuditVerifyConfig } from '../config/env.ts';
import { createDatabase } from '../db/kysely.ts';
import { scrubString } from '../observability/redaction.ts';

async function main(): Promise<void> {
  const config = loadAuditVerifyConfig();
  const db = createDatabase({ connectionString: config.databaseUrl.reveal(), applicationName: 'mtw-audit-verify' });
  try {
    const result = await verifyAuditChain(db, config.auditChainKey);
    if (result.ok) {
      process.stdout.write(
        `AUDIT CHAIN OK: ${result.count} eventos${result.headId ? `, cabeza id ${result.headId} (${result.headHash ?? ''})` : ''}\n`,
      );
    } else {
      process.stderr.write(
        `AUDIT CHAIN ROTA en el evento id ${result.brokenAtId} (${result.reason}) tras ${result.count} eventos válidos\n`,
      );
      process.exitCode = 1;
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${scrubString(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
});
