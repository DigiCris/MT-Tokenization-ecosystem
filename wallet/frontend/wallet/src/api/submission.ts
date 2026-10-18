// Envelope de envío de una firma de SafeTx ([B-PSES-06], [F-SES-03]): "MTW-SUBMIT-V1\n" + JCS({operationId, safeTxHash,
// sessionId, submittedAt}) firmado con la session key. Ata la firma de U a esa operación, ese hash y esa PlatformSession:
// el backend y el signer lo verifican antes de encolar. Vector: test/vectors/wire/p256.json (submissionEnvelope).
import { canonicalize } from './jcs.ts';
import { signP256, type SessionKey } from './session-key.ts';

export const SUBMISSION_VERSION = 'MTW-SUBMIT-V1';

export interface SubmissionEnvelope {
  operationId: string;
  safeTxHash: `0x${string}`;
  sessionId: string;
  /** Unix en segundos (entero); el backend lo acepta a ±60 s de su hora. */
  submittedAt: number;
}

export function submissionCanonical(envelope: SubmissionEnvelope): string {
  return `${SUBMISSION_VERSION}\n${canonicalize({ ...envelope })}`;
}

export async function signSubmission(
  key: SessionKey,
  fields: Omit<SubmissionEnvelope, 'submittedAt'>,
  nowMs: number = Date.now(),
): Promise<{ submissionEnvelope: SubmissionEnvelope; submissionEnvelopeSignature: string }> {
  const submissionEnvelope: SubmissionEnvelope = { ...fields, submittedAt: Math.floor(nowMs / 1000) };
  return {
    submissionEnvelope,
    submissionEnvelopeSignature: await signP256(key.privateKey, submissionCanonical(submissionEnvelope)),
  };
}
