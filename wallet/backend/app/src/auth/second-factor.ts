// Segundo factor [B-AUTH-09]: código TOTP (anti-replay por paso) o código de recuperación de un solo uso. Lo usan el
// login, la desactivación del TOTP y el step-up de PlatformSession ([B-PSES-03]). Bloquea la fila del factor: dos
// requests con el mismo código no pueden validarse a la vez.
import { sql, type Transaction } from 'kysely';
import type { Secret } from '../config/secret.ts';
import type { Database } from '../db/schema.ts';
import { matchRecoveryCode, openTotpSecret, verifyTotp } from './totp.ts';

export interface SecondFactorInput {
  totp?: string | undefined;
  recoveryCode?: string | undefined;
}

/** true si el código es válido (y queda consumido); false si no hay factor activo o el código no sirve. */
export async function verifySecondFactor(
  trx: Transaction<Database>,
  fieldKey: Secret<Buffer>,
  userId: string,
  input: SecondFactorInput,
): Promise<boolean> {
  const factor = await trx
    .selectFrom('totp_factors')
    .select(['secret_ciphertext', 'last_used_step', 'recovery_code_hashes', 'enabled_at'])
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  if (!factor || factor.enabled_at === null) return false;
  if (input.totp !== undefined) {
    const secret = openTotpSecret(fieldKey, userId, factor.secret_ciphertext);
    const check = verifyTotp(secret, input.totp, factor.last_used_step === null ? null : BigInt(factor.last_used_step));
    if (!check.ok) return false;
    await trx
      .updateTable('totp_factors')
      .set({ last_used_step: check.step.toString() })
      .where('user_id', '=', userId)
      .execute();
    return true;
  }
  if (input.recoveryCode !== undefined) {
    const index = await matchRecoveryCode(input.recoveryCode, factor.recovery_code_hashes);
    if (index < 0) return false;
    const remaining = factor.recovery_code_hashes.filter((_, i) => i !== index);
    await trx
      .updateTable('totp_factors')
      .set({ recovery_code_hashes: sql`${remaining}::text[]` })
      .where('user_id', '=', userId)
      .execute();
    return true;
  }
  return false;
}
