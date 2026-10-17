// Operaciones tipificadas V1 [B-POL-03] y matriz scope → operaciones [W-07] (implementación propia del signer; el
// backend tiene la suya y ambas se contrastan con contracts/test/vectors/policy/policy.json y wire/scopes.json).
export const OPERATION_TYPES = [
  'SEND',
  'SWAP_APPROVE',
  'SWAP',
  'APPROVE_REVOKE',
  'WHITELIST_ADD',
  'WHITELIST_REMOVE',
  'ROTATION_PROPOSE',
  'ROTATION_EXECUTE',
  'NOOP_CANCEL',
  'MIGRATION_TRANSFER',
  'GUARD_UPGRADE',
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

export const OWNER_ROLES = ['U', 'R'] as const;
export type OwnerRole = (typeof OWNER_ROLES)[number];

export const PLATFORM_SCOPES = [
  'OPERATIONS',
  'ONBOARDING',
  'RECOVERY',
  'U_REPLACEMENT',
  'ENROLLMENT',
  'KEY_RESTORE',
] as const;
export type PlatformScope = (typeof PLATFORM_SCOPES)[number];

/**
 * Tipo de propuesta del RotationTimelock (enum RotationKind de los contratos, desde 0: U, R, S, GUARD, MODULE_GUARD).
 * Ojo: el enum Role (KeyAcceptance, evaluateAssisted) empieza en 1 (U = 1, R = 2, S = 3).
 */
export const ROTATION_KINDS = { 0: 'U', 1: 'R', 2: 'S', 3: 'GUARD', 4: 'MODULE_GUARD' } as const;

/** enum Role de los contratos (KeyAcceptance.role, SecurityGuard.evaluateAssisted). */
export const ROLE_ENUM = { U: 1, R: 2, S: 3 } as const;
export type RotationKind = (typeof ROTATION_KINDS)[keyof typeof ROTATION_KINDS];

/**
 * [W-07]: qué operaciones puede co-firmar S según el scope de la PlatformSession y el rol que firmó. ROTATION_PROPOSE
 * con R sólo para U o S (nunca R ni el Guard).
 */
export const SCOPE_OPERATIONS: Readonly<
  Record<PlatformScope, Readonly<Partial<Record<OwnerRole, readonly OperationType[]>>>>
> = {
  OPERATIONS: {
    U: [
      'SEND',
      'SWAP_APPROVE',
      'SWAP',
      'APPROVE_REVOKE',
      'WHITELIST_ADD',
      'WHITELIST_REMOVE',
      'ROTATION_PROPOSE',
      'ROTATION_EXECUTE',
      'NOOP_CANCEL',
      'MIGRATION_TRANSFER',
      'GUARD_UPGRADE',
    ],
  },
  RECOVERY: {
    R: [
      'ROTATION_PROPOSE',
      'ROTATION_EXECUTE',
      'NOOP_CANCEL',
      'WHITELIST_REMOVE',
      'APPROVE_REVOKE',
      'MIGRATION_TRANSFER',
    ],
  },
  U_REPLACEMENT: {},
  ENROLLMENT: {},
  ONBOARDING: {},
  KEY_RESTORE: {},
};

/** Rotaciones que puede proponer cada rol ([C-GRD-11]). */
export const ROTATION_KINDS_BY_ROLE: Readonly<Record<OwnerRole, readonly RotationKind[]>> = {
  U: ['U', 'R', 'S', 'GUARD', 'MODULE_GUARD'],
  R: ['U', 'S'],
};

export function scopeAllows(scope: PlatformScope, role: OwnerRole, type: OperationType): boolean {
  return SCOPE_OPERATIONS[scope][role]?.includes(type) ?? false;
}
