// Aprobaciones de reanudación (P20.T04): después de un MISMATCH la cooperación de S queda pausada hasta que el release
// servido vuelve a verificar (OK) **y** dos operadores distintos aprueban reanudar ese release exacto. Cada operador
// firma con su propia clave Ed25519 (fijada en el monitor, fuera del backend: el monitor no confía en las credenciales de
// ningún otro componente) el JSON canónico de la acción; la aprobación vence a la hora.
import { sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import type { App } from './check.ts';
import { canonicalize } from './jcs.ts';

export const APPROVAL_MAX_AGE_SECONDS = 3_600;

export const ResumeApprovalSchema = z
  .object({
    operatorId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
    app: z.enum(['WALLET', 'RECOVERY']),
    releaseId: z.string().min(1).max(128),
    manifestSha256: z.string().regex(/^0x[0-9a-f]{64}$/),
    issuedAt: z.number().int().positive(),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type ResumeApproval = z.infer<typeof ResumeApprovalSchema>;

export interface ApprovalContext {
  platformId: string;
  environment: string;
}

export function approvalMessage(approval: Omit<ResumeApproval, 'signature'>, context: ApprovalContext): Buffer {
  return Buffer.from(
    canonicalize({
      action: 'INTEGRITY_RESUME',
      platformId: context.platformId,
      environment: context.environment,
      app: approval.app,
      releaseId: approval.releaseId,
      manifestSha256: approval.manifestSha256,
      operatorId: approval.operatorId,
      issuedAt: approval.issuedAt,
    }),
  );
}

export function signApproval(
  fields: Omit<ResumeApproval, 'signature'>,
  context: ApprovalContext,
  privateKey: KeyObject,
): ResumeApproval {
  return { ...fields, signature: sign(null, approvalMessage(fields, context), privateKey).toString('base64url') };
}

/** Motivo por el que la aprobación no vale (o `null` si vale) para esa app, release y manifest. */
export function approvalProblem(
  approval: ResumeApproval,
  context: ApprovalContext & { operatorKeys: ReadonlyMap<string, KeyObject>; now: number },
  expected: { app: App; releaseId: string; manifestSha256: string },
): string | null {
  const key = context.operatorKeys.get(approval.operatorId);
  if (key === undefined) return 'operador desconocido';
  if (approval.app !== expected.app) return 'la aprobación es de otra app';
  if (approval.releaseId !== expected.releaseId || approval.manifestSha256 !== expected.manifestSha256) {
    return 'la aprobación es de otro release';
  }
  if (approval.issuedAt > context.now + 60) return 'la aprobación tiene fecha futura';
  if (context.now - approval.issuedAt > APPROVAL_MAX_AGE_SECONDS) return 'la aprobación venció';
  const { signature, ...fields } = approval;
  if (!verify(null, approvalMessage(fields, context), key, Buffer.from(signature, 'base64url'))) {
    return 'la firma de la aprobación no verifica';
  }
  return null;
}
