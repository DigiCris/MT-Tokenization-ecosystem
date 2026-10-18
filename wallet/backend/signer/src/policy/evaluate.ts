// Evaluación de policy del signer [B-POL-02/03/04] (P11.T03), PURA: recibe la SafeTx, el rol, el scope de la sesión,
// el tipo declarado y los HECHOS ya leídos y verificados por el pipeline (roles on-chain, saldos, whitelist, ledger
// 24 h, atestaciones de challenge, emparejamiento approve/swap, propuestas del timelock...) y devuelve un veredicto con
// un código estable. Sin E/S: es lo que se contrasta contra contracts/test/vectors/policy/policy.json (mismo veredicto
// que el backend para cada caso).
import { sameAddress, type Address } from '../crypto/keccak.ts';
import type { SafeTx } from '../chain/safe-tx.ts';
import {
  ROTATION_KINDS_BY_ROLE,
  scopeAllows,
  type OperationType,
  type OwnerRole,
  type PlatformScope,
} from './operations.ts';
import type { PolicySnapshot } from './snapshot.ts';
import {
  classifySafeTx,
  SENTINEL_ADDRESS,
  StaticRuleViolation,
  systemAddresses,
  ZERO_ADDRESS,
  type TypedOperation,
} from './static-rules.ts';

export const POLICY_REJECT_CODES = [
  'UNKNOWN_OPERATION',
  'OPERATION_TYPE_MISMATCH',
  'OPERATION_NOT_ALLOWED',
  'DESTINATION_FORBIDDEN',
  'DESTINATION_NOT_WHITELISTED',
  'BELOW_MINIMUM',
  'LIMIT_PER_OPERATION',
  'LIMIT_DAILY',
  'SWAP_LIMIT',
  'TWO_FACTOR_REQUIRED',
  'CHALLENGE_REQUIRED',
  'INSUFFICIENT_BALANCE',
  'SLIPPAGE_TOO_HIGH',
  'DEADLINE_INVALID',
  'SWAP_PAIRING_INVALID',
  'ROTATION_INVALID',
  'ROTATION_NOT_EXECUTABLE',
  'KEY_ACCEPTANCE_REQUIRED',
  'ROTATION_TARGET_NOT_SIGNER_KEY',
  'MIGRATION_PARTIAL',
  'GUARD_UPGRADE_INVALID',
] as const;
export type PolicyRejectCode = (typeof POLICY_REJECT_CODES)[number];

export interface PolicyFacts {
  /** Segundos Unix al evaluar. */
  now: number;
  /** Roles vigentes on-chain (SecurityGuard.rolesOf). */
  roles: { userKey: Address; recoveryKey: Address; executor: Address };
  /** Salida acumulada de SEND de la Safe en las últimas 24 h, sin esta operación (ledger del signer). */
  dailyOutflowUsed: bigint;
  /** Saldo de la Safe del token de la operación (SEND/MIGRATION/SWAP_APPROVE: el token; SWAP: tokenIn). */
  balance?: bigint;
  /** SWAP: allowance(safe, executor) de tokenIn on-chain. */
  allowance?: bigint;
  /** SEND: destino activo en DestinationWhitelist. */
  destinationWhitelisted?: boolean;
  /** TRANSFER: PolicyRegistry.isMigrationAuthorized(safe, destino). */
  migrationAuthorized?: boolean;
  /** SEND ≥ umbral: atestación ChallengeCompletion HIGH_VALUE_TX válida y ligada a esta operación. */
  twoFactorVerified?: boolean;
  /** WHITELIST_ADD: atestación ChallengeCompletion WHITELIST_ADD válida y ligada a esta operación. */
  whitelistChallengeVerified?: boolean;
  /** SWAP_APPROVE: la SafeTx SWAP N+1 que lo acompaña (firma de U ya verificada o no). */
  pairedSwap?: { safeTx: SafeTx; ownerSignatureValid: boolean } | null;
  /** SWAP: el signer co-firmó el SWAP_APPROVE N−1 emparejado con esta SWAP. */
  approvalSigned?: boolean;
  /** Rotación de U o R: KeyAcceptance válido firmado por la nueva clave. */
  keyAcceptanceValid?: boolean;
  /** Rotación de S: la nueva clave la creó un signer para esta wallet (SignerKeyAttestation válida). */
  newKeyIsSignerKey?: boolean;
  /** ROTATION_EXECUTE: propuesta PENDING y madura en el timelock para (safe, rol, old, new). */
  rotationExecutable?: boolean;
  /** ROTATION_EXECUTE: `prevOwner` es el owner anterior a `oldOwner` en la lista de la Safe. */
  prevOwnerCorrect?: boolean;
  /** Rotación GUARD/MODULE_GUARD: slots actuales de la Safe. */
  currentGuard?: Address;
  currentModuleGuard?: Address;
  /** GUARD/MODULE_GUARD: el nuevo valor es sucesor registrado y activo en PolicyRegistry. */
  successorRegistered?: boolean;
  /** GUARD_UPGRADE: propuesta GUARD/MODULE_GUARD madura y no cancelada en el timelock. */
  guardUpgradeMature?: boolean;
  /** RotationTimelock del Guard que gobierna la Safe ([C-GRD-17]); sin el dato, el del sistema. */
  safeTimelock?: Address;
}

export interface PolicyInput {
  safe: Address;
  role: OwnerRole;
  scope: PlatformScope;
  declaredType: OperationType;
  safeTx: SafeTx;
  facts: PolicyFacts;
}

export type PolicyVerdict =
  | { verdict: 'ACCEPT'; operation: TypedOperation; type: OperationType; outflow: bigint }
  | { verdict: 'REJECT'; code: PolicyRejectCode; detail?: string };

const reject = (code: PolicyRejectCode, detail?: string): PolicyVerdict => ({
  verdict: 'REJECT',
  code,
  ...(detail === undefined ? {} : { detail }),
});

function roleKey(facts: PolicyFacts, kind: 'U' | 'R' | 'S'): Address {
  return kind === 'U' ? facts.roles.userKey : kind === 'R' ? facts.roles.recoveryKey : facts.roles.executor;
}

function forbiddenDestination(snapshot: PolicySnapshot, safe: Address, destination: Address): boolean {
  return (
    sameAddress(destination, ZERO_ADDRESS) ||
    sameAddress(destination, safe) ||
    systemAddresses(snapshot).some((a) => sameAddress(a, destination))
  );
}

/** Mínimo de salida que exige el Guard: amountIn·(10.000 − maxSlippage)/10.000 (división entera). */
export function minimumOut(amountIn: bigint, maxSlippageBps: number): bigint {
  return (amountIn * BigInt(10_000 - maxSlippageBps)) / 10_000n;
}

function checkSwap(
  snapshot: PolicySnapshot,
  op: Extract<TypedOperation, { type: 'SWAP' }>,
  now: number,
): PolicyVerdict | undefined {
  if (op.amountIn < snapshot.limits.minPerOperation) return reject('BELOW_MINIMUM');
  if (op.amountIn > snapshot.limits.swapMax) return reject('SWAP_LIMIT');
  if (op.minAmountOut < minimumOut(op.amountIn, snapshot.swap.maxSlippageBps)) return reject('SLIPPAGE_TOO_HIGH');
  const latest = BigInt(now + snapshot.swap.deadlineSeconds + snapshot.session.clockSkewSeconds);
  if (op.deadline < BigInt(now) || op.deadline > latest) return reject('DEADLINE_INVALID');
  return undefined;
}

export function evaluatePolicy(snapshot: PolicySnapshot, input: PolicyInput): PolicyVerdict {
  const { safe, role, scope, declaredType, safeTx, facts } = input;
  let op: TypedOperation;
  try {
    op = classifySafeTx(snapshot, safe, safeTx);
  } catch (error) {
    if (error instanceof StaticRuleViolation) return reject('UNKNOWN_OPERATION', error.rule);
    throw error;
  }

  // Tipo efectivo: una transferencia es MIGRATION_TRANSFER si y sólo si el destino tiene autorización de migración
  // (misma regla que el Guard, [C-GRD-06]).
  let type: OperationType;
  if (op.type === 'TRANSFER') type = facts.migrationAuthorized === true ? 'MIGRATION_TRANSFER' : 'SEND';
  else type = op.type;
  if (type !== declaredType) return reject('OPERATION_TYPE_MISMATCH', `${declaredType} → ${type}`);
  if (!snapshot.operations[role].includes(type) || !scopeAllows(scope, role, type)) {
    return reject('OPERATION_NOT_ALLOWED', `${scope}/${role}/${type}`);
  }

  switch (op.type) {
    case 'NOOP_CANCEL':
    case 'APPROVE_REVOKE':
    case 'WHITELIST_REMOVE':
      return { verdict: 'ACCEPT', operation: op, type, outflow: 0n };

    case 'TRANSFER': {
      if (forbiddenDestination(snapshot, safe, op.destination)) return reject('DESTINATION_FORBIDDEN');
      if (op.amount === 0n) return reject('BELOW_MINIMUM');
      if (type === 'MIGRATION_TRANSFER') {
        // Exenta de los límites de 24 h y por operación; mueve el saldo completo del token.
        if (facts.balance === undefined || op.amount !== facts.balance) return reject('MIGRATION_PARTIAL');
        return { verdict: 'ACCEPT', operation: op, type, outflow: 0n };
      }
      if (op.amount < snapshot.limits.minPerOperation) return reject('BELOW_MINIMUM');
      if (op.amount > snapshot.limits.perOperationMax) return reject('LIMIT_PER_OPERATION');
      if (facts.dailyOutflowUsed + op.amount > snapshot.limits.dailyOutflowMax) return reject('LIMIT_DAILY');
      if (facts.destinationWhitelisted !== true) return reject('DESTINATION_NOT_WHITELISTED');
      if (facts.balance === undefined || facts.balance < op.amount) return reject('INSUFFICIENT_BALANCE');
      if (op.amount >= snapshot.limits.twoFactorThreshold && facts.twoFactorVerified !== true) {
        return reject('TWO_FACTOR_REQUIRED');
      }
      return { verdict: 'ACCEPT', operation: op, type, outflow: op.amount };
    }

    case 'SWAP_APPROVE': {
      if (op.amount < snapshot.limits.minPerOperation) return reject('BELOW_MINIMUM');
      if (op.amount > snapshot.limits.swapMax) return reject('SWAP_LIMIT');
      if (facts.balance === undefined || facts.balance < op.amount) return reject('INSUFFICIENT_BALANCE');
      // [B-SIG-02] secuencia: el approve N sólo viaja con su SWAP N+1 firmado por U, mismo executor y monto exacto.
      const paired = facts.pairedSwap;
      if (paired === undefined || paired === null || !paired.ownerSignatureValid) return reject('SWAP_PAIRING_INVALID');
      if (paired.safeTx.nonce !== safeTx.nonce + 1n) return reject('SWAP_PAIRING_INVALID', 'nonce');
      let swap: TypedOperation;
      try {
        swap = classifySafeTx(snapshot, safe, paired.safeTx);
      } catch {
        return reject('SWAP_PAIRING_INVALID', 'SafeTx emparejada inválida');
      }
      if (
        swap.type !== 'SWAP' ||
        !sameAddress(swap.executor, op.spender) ||
        !sameAddress(swap.tokenIn, op.token) ||
        swap.amountIn !== op.amount
      ) {
        return reject('SWAP_PAIRING_INVALID');
      }
      return checkSwap(snapshot, swap, facts.now) ?? { verdict: 'ACCEPT', operation: op, type, outflow: 0n };
    }

    case 'SWAP': {
      const invalid = checkSwap(snapshot, op, facts.now);
      if (invalid !== undefined) return invalid;
      if (facts.approvalSigned !== true || facts.allowance !== op.amountIn) return reject('SWAP_PAIRING_INVALID');
      if (facts.balance === undefined || facts.balance < op.amountIn) return reject('INSUFFICIENT_BALANCE');
      return { verdict: 'ACCEPT', operation: op, type, outflow: 0n };
    }

    case 'WHITELIST_ADD':
      if (forbiddenDestination(snapshot, safe, op.destination)) return reject('DESTINATION_FORBIDDEN');
      if (facts.whitelistChallengeVerified !== true) return reject('CHALLENGE_REQUIRED');
      return { verdict: 'ACCEPT', operation: op, type, outflow: 0n };

    case 'ROTATION_PROPOSE': {
      if (!ROTATION_KINDS_BY_ROLE[role].includes(op.kind))
        return reject('ROTATION_INVALID', `${role} no propone ${op.kind}`);
      if (!sameAddress(op.timelock, facts.safeTimelock ?? snapshot.contracts.rotationTimelock)) {
        return reject('ROTATION_INVALID', 'timelock');
      }
      if (op.kind === 'GUARD' || op.kind === 'MODULE_GUARD') {
        const current = op.kind === 'GUARD' ? facts.currentGuard : facts.currentModuleGuard;
        if (current === undefined || !sameAddress(current, op.oldValue)) return reject('ROTATION_INVALID', 'old');
        if (facts.successorRegistered !== true) return reject('GUARD_UPGRADE_INVALID');
        return { verdict: 'ACCEPT', operation: op, type, outflow: 0n };
      }
      if (!sameAddress(roleKey(facts, op.kind), op.oldValue)) return reject('ROTATION_INVALID', 'old');
      const taken = [
        facts.roles.userKey,
        facts.roles.recoveryKey,
        facts.roles.executor,
        ZERO_ADDRESS,
        SENTINEL_ADDRESS,
      ];
      if (taken.some((a) => sameAddress(a, op.newValue)) || forbiddenDestination(snapshot, safe, op.newValue)) {
        return reject('ROTATION_INVALID', 'new');
      }
      if (op.kind === 'S') {
        if (facts.newKeyIsSignerKey !== true) return reject('ROTATION_TARGET_NOT_SIGNER_KEY');
      } else if (facts.keyAcceptanceValid !== true) {
        return reject('KEY_ACCEPTANCE_REQUIRED');
      }
      return { verdict: 'ACCEPT', operation: op, type, outflow: 0n };
    }

    case 'ROTATION_EXECUTE': {
      const kind = (['U', 'R', 'S'] as const).find((k) => sameAddress(roleKey(facts, k), op.oldOwner));
      if (kind === undefined) return reject('ROTATION_INVALID', 'old no es un rol vigente');
      if (role === 'R' && kind === 'R') return reject('ROTATION_INVALID', 'R no ejecuta la rotación de R');
      const owners = [facts.roles.userKey, facts.roles.recoveryKey, facts.roles.executor];
      if (owners.some((a) => sameAddress(a, op.newOwner)) || forbiddenDestination(snapshot, safe, op.newOwner)) {
        return reject('ROTATION_INVALID', 'new');
      }
      if (facts.prevOwnerCorrect !== true) return reject('ROTATION_INVALID', 'prev');
      if (facts.rotationExecutable !== true) return reject('ROTATION_NOT_EXECUTABLE');
      if (kind === 'S') {
        if (facts.newKeyIsSignerKey !== true) return reject('ROTATION_TARGET_NOT_SIGNER_KEY');
      } else if (facts.keyAcceptanceValid !== true) {
        return reject('KEY_ACCEPTANCE_REQUIRED');
      }
      return { verdict: 'ACCEPT', operation: op, type, outflow: 0n };
    }

    case 'GUARD_UPGRADE':
      if (facts.successorRegistered !== true || facts.guardUpgradeMature !== true)
        return reject('GUARD_UPGRADE_INVALID');
      return { verdict: 'ACCEPT', operation: op, type, outflow: 0n };
  }
}
