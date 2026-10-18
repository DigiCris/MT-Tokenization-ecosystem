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
  /** ISO 8601 en UTC sin milisegundos. */
  submittedAt: string;
}

export function submissionCanonical(envelope: SubmissionEnvelope): string {
  return `${SUBMISSION_VERSION}\n${canonicalize({ ...envelope })}`;
}

export async function signSubmission(
  key: SessionKey,
  fields: Omit<SubmissionEnvelope, 'submittedAt'>,
  now: Date = new Date(),
): Promise<{ submissionEnvelope: SubmissionEnvelope; submissionEnvelopeSignature: string }> {
  const submissionEnvelope: SubmissionEnvelope = {
    ...fields,
    submittedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  return {
    submissionEnvelope,
    submissionEnvelopeSignature: await signP256(key.privateKey, submissionCanonical(submissionEnvelope)),
  };
}
