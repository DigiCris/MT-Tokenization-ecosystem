// Errores tipificados de la API mTLS del signer [B-SIG-02]. El backend usa `code` para clasificar la operación
// ([B-Q-03]: `retryable` → FAILED_RETRYABLE con backoff; si no → FAILED_FINAL) y `reason` para el detalle estable
// (regla estática, código de policy, motivo del Guard). Nunca incluyen datos sensibles.
export const SIGNER_ERRORS = {
  BAD_REQUEST: { status: 400, retryable: false },
  UNAUTHORIZED_CLIENT: { status: 403, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  STATIC_RULE_VIOLATION: { status: 422, retryable: false },
  POLICY_VERSION_MISMATCH: { status: 409, retryable: true },
  SESSION_INVALID: { status: 422, retryable: false },
  SIGNATURE_STALE: { status: 422, retryable: false },
  INTEGRITY_PAUSED: { status: 503, retryable: true },
  OWNER_SIGNATURE_INVALID: { status: 422, retryable: false },
  OWNER_NOT_ROLE: { status: 422, retryable: false },
  SAFE_NOT_REGISTERED: { status: 422, retryable: false },
  SAFE_CONFIG_MODIFIED: { status: 422, retryable: false },
  KEY_NOT_FOUND: { status: 422, retryable: false },
  NONCE_NOT_REACHED: { status: 409, retryable: true },
  NONCE_CONSUMED: { status: 409, retryable: false },
  POLICY_REJECTED: { status: 422, retryable: false },
  GUARD_WOULD_REVERT: { status: 422, retryable: false },
  SAFE_NONCE_CONFLICT: { status: 409, retryable: false },
  ACCOUNT_NONCE_MISMATCH: { status: 409, retryable: true },
  INSUFFICIENT_GAS_FUNDS: { status: 409, retryable: true },
  SIMULATION_REVERTED: { status: 422, retryable: false },
  GAS_TANK_CAP_EXCEEDED: { status: 409, retryable: true },
  PLATFORM_TX_REJECTED: { status: 422, retryable: false },
  RPC_UNAVAILABLE: { status: 503, retryable: true },
  RPC_DISAGREEMENT: { status: 503, retryable: true },
  SIGNER_NOT_READY: { status: 503, retryable: true },
  INTERNAL: { status: 500, retryable: true },
} as const;
export type SignerErrorCode = keyof typeof SIGNER_ERRORS;

export class SignerError extends Error {
  override name = 'SignerError';
  readonly code: SignerErrorCode;
  readonly reason: string | undefined;

  constructor(code: SignerErrorCode, reason?: string, message?: string) {
    super(message ?? (reason === undefined ? code : `${code}: ${reason}`));
    this.code = code;
    this.reason = reason;
  }

  get status(): number {
    return SIGNER_ERRORS[this.code].status;
  }

  get retryable(): boolean {
    return SIGNER_ERRORS[this.code].retryable;
  }

  toJSON(): { code: SignerErrorCode; reason?: string; retryable: boolean } {
    return {
      code: this.code,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      retryable: this.retryable,
    };
  }
}
