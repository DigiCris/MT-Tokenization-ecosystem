// Sobre de envío de una firma de R ([B-PSES-06]): al mandar la firma de una SafeTx, la session key de la PlatformSession
// firma `MTW-SUBMIT-V1\n` + JCS({operationId, safeTxHash, sessionId, submittedAt}) con `submittedAt` en segundos Unix
// (hora alineada al servidor): ata la firma a esa operación, ese hash y esa sesión.
import type { Hex } from 'viem';
import { canonicalize } from './jcs.ts';
import { signP256 } from './session-key.ts';

export interface SubmissionEnvelope {
  operationId: string;
  safeTxHash: Hex;
  sessionId: string;
  submittedAt: number;
}

export function submissionCanonical(envelope: SubmissionEnvelope): string {
  return `MTW-SUBMIT-V1\n${canonicalize({ ...envelope })}`;
}

export async function signSubmission(
  key: CryptoKey,
  fields: Omit<SubmissionEnvelope, 'submittedAt'>,
  nowSeconds: number,
): Promise<{ submissionEnvelope: SubmissionEnvelope; submissionEnvelopeSignature: string }> {
  const submissionEnvelope: SubmissionEnvelope = { ...fields, submittedAt: nowSeconds };
  return {
    submissionEnvelope,
    submissionEnvelopeSignature: await signP256(key, submissionCanonical(submissionEnvelope)),
  };
}
