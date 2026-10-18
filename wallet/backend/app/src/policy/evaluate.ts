// Policy del backend [B-POL-02/03/04/05] (P13.T10), PURA e independiente de la del signer: clasifica la SafeTx desde
// sus bytes (decoder estricto de chain/decoders), exige que coincida con el tipo declarado, aplica la matriz
// scope → operaciones [W-07] y las operaciones habilitadas por rol del snapshot, y evalúa cada tipo con los HECHOS ya
// leídos por el llamador (roles on-chain, saldos, whitelist, ledger de 24 h, challenges, emparejamiento approve/swap,
// propuestas del timelock). Devuelve un veredicto con un código estable; los mismos casos de
// contracts/test/vectors/policy/policy.json los evalúa el signer con su implementación.
import { isAddressEqual, type Address, type Hex } from 'viem';
import { RotationKind, type SystemAddresses } from '../chain/constants.ts';
import { decodeSafeCall, UndecodableCallError, type DecodedCall } from '../chain/decoders/safe-call.ts';
import type { SafeTx } from '../chain/safe-tx.ts';
import type { BackendPolicySnapshot, OperationKind } from './snapshot.ts';

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

export type OwnerRole = 'U' | 'R';
export type SessionScope = 'OPERATIONS' | 'ONBOARDING' | 'RECOVERY' | 'U_REPLACEMENT' | 'ENROLLMENT' | 'KEY_RESTORE';

/** Hechos leídos y verificados por el llamador (prepare o el paso 6 del worker). */
export interface PolicyFacts {
  /** Segundos Unix (timestamp del bloque de lectura). */
  now: number;
  /** Roles vigentes on-chain (SecurityGuard.rolesOf). */
  roles: { userKey: Address; recoveryKey: Address; executor: Address };
  /** Salida de SEND de la Safe en las últimas 24 h, sin esta operación (ledger del backend). */
  dailyOutflowUsed: bigint;
  /** Saldo de la Safe del token de la operación (SWAP: tokenIn). */
  balance?: bigint;
  /** SWAP: allowance(safe, SwapExecutor) de tokenIn. */
  allowance?: bigint;
  /** SEND: destino activo en DestinationWhitelist. */
  destinationWhitelisted?: boolean;
  /** transfer: PolicyRegistry.isMigrationAuthorized(safe, destino). */
  migrationAuthorized?: boolean;
  /** SEND ≥ umbral de 2FA: challenge HIGH_VALUE_TX completado y ligado a esta operación. */
  twoFactorVerified?: boolean;
  /** WHITELIST_ADD: challenge WHITELIST_ADD completado y ligado a esta operación. */
  whitelistChallengeVerified?: boolean;
  /** SWAP_APPROVE: la SafeTx SWAP N+1 que lo acompaña y si su firma de U es válida. */
  pairedSwap?: { safeTx: SafeTx; ownerSignatureValid: boolean } | null;
  /** SWAP: el SWAP_APPROVE N−1 emparejado ya fue co-firmado. */
  approvalSigned?: boolean;
  /** Rotación de U o R: KeyAcceptance válido de la clave nueva. */
  keyAcceptanceValid?: boolean;
  /** Rotación de S: la clave nueva la creó un signer para esta wallet. */
  newKeyIsSignerKey?: boolean;
  /** ROTATION_EXECUTE: propuesta pendiente y madura en el timelock. */
  rotationExecutable?: boolean;
  /** ROTATION_EXECUTE: `prevOwner` precede a `oldOwner` en la lista de owners. */
  prevOwnerCorrect?: boolean;
  /** Rotación de GUARD/MODULE_GUARD: slots actuales. */
  currentGuard?: Address;
  currentModuleGuard?: Address;
  /** GUARD/MODULE_GUARD: el valor nuevo es sucesor registrado y activo en PolicyRegistry. */
  successorRegistered?: boolean;
  /** GUARD_UPGRADE: propuesta de GUARD/MODULE_GUARD madura y no cancelada. */
  guardUpgradeMature?: boolean;
}

export interface PolicyInput {
  safe: Address;
  role: OwnerRole;
  scope: SessionScope;
  declaredType: OperationKind;
  safeTx: SafeTx;
  facts: PolicyFacts;
}

export type PolicyVerdict =
  | { verdict: 'ACCEPT'; type: OperationKind; call: DecodedCall; outflow: bigint }
  | { verdict: 'REJECT'; code: PolicyRejectCode; detail?: string };

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const SENTINEL: Address = '0x0000000000000000000000000000000000000001';

/** [W-07]: qué scope y qué rol co-firman (el resto de los scopes no co-firma ninguna operación). */
const SCOPE_OF_ROLE: Readonly<Record<OwnerRole, SessionScope>> = { U: 'OPERATIONS', R: 'RECOVERY' };

function reject(code: PolicyRejectCode, detail?: string): PolicyVerdict {
  return { verdict: 'REJECT', code, ...(detail === undefined ? {} : { detail }) };
}

function systemAddresses(snapshot: BackendPolicySnapshot): SystemAddresses {
  const c = snapshot.contracts;
  return {
    securityGuard: c.securityGuard,
    rotationTimelock: c.rotationTimelock,
    walletFactory: c.walletFactory,
    safeBootstrap: c.safeBootstrap,
    policyRegistry: c.policyRegistry,
    destinationWhitelist: c.destinationWhitelist,
    denyAllModuleGuard: c.denyAllModuleGuard,
    swapExecutor: c.swapExecutor,
    usdc: snapshot.tokens.USDC,
    usdt: snapshot.tokens.USDT,
  };
}

/** Contratos del sistema, de Safe y tokens: nunca son destino de fondos, de whitelist ni claves de una Safe. */
function isSystemAddress(snapshot: BackendPolicySnapshot, address: Address): boolean {
  return [...Object.values(snapshot.contracts), snapshot.tokens.USDC, snapshot.tokens.USDT].some((a) =>
    isAddressEqual(a, address),
  );
}

function forbiddenDestination(snapshot: BackendPolicySnapshot, safe: Address, destination: Address): boolean {
  return (
    isAddressEqual(destination, ZERO) || isAddressEqual(destination, safe) || isSystemAddress(snapshot, destination)
  );
}

/** Slippage contra la paridad 1:1 del par USDC/USDT, en bps (redondeo hacia arriba: nunca se subestima). */
function slippageBps(amountIn: bigint, minAmountOut: bigint): bigint {
  if (minAmountOut >= amountIn) return 0n;
  return ((amountIn - minAmountOut) * 10_000n + amountIn - 1n) / amountIn;
}

/** Estructura de una SafeTx asistida: CALL sin ETH ni parámetros de reembolso o gas. */
function structurallyValid(safeTx: SafeTx): boolean {
  return (
    safeTx.operation === 0 &&
    safeTx.value === 0n &&
    safeTx.safeTxGas === 0n &&
    safeTx.baseGas === 0n &&
    safeTx.gasPrice === 0n &&
    isAddressEqual(safeTx.gasToken, ZERO) &&
    isAddressEqual(safeTx.refundReceiver, ZERO)
  );
}

/** Tipo de operación de una llamada decodificada (null: no es una operación de V1). */
export function classifyCall(
  snapshot: BackendPolicySnapshot,
  call: DecodedCall,
  facts: Pick<PolicyFacts, 'migrationAuthorized'>,
): OperationKind | null {
  switch (call.kind) {
    case 'NOOP':
      return 'NOOP_CANCEL';
    case 'ERC20_TRANSFER':
      return facts.migrationAuthorized === true ? 'MIGRATION_TRANSFER' : 'SEND';
    case 'ERC20_APPROVE':
      if (!isAddressEqual(call.spender, snapshot.contracts.swapExecutor)) return null;
      return call.amount === 0n ? 'APPROVE_REVOKE' : 'SWAP_APPROVE';
    case 'SWAP':
      return 'SWAP';
    case 'WHITELIST_ADD':
      return 'WHITELIST_ADD';
    case 'WHITELIST_REMOVE':
      return 'WHITELIST_REMOVE';
    case 'ROTATION_PROPOSE':
      return 'ROTATION_PROPOSE';
    case 'SWAP_OWNER':
      return 'ROTATION_EXECUTE';
    case 'SET_GUARD':
    case 'SET_MODULE_GUARD':
      return 'GUARD_UPGRADE';
    // La cancelación de una rotación es por firma individual (relay), nunca por SafeTx.
    case 'ROTATION_CANCEL':
      return null;
  }
}

/** Decodifica la SafeTx (estructura + llamada canónica); null si no es una operación de V1. */
export function decodeOperation(snapshot: BackendPolicySnapshot, safe: Address, safeTx: SafeTx): DecodedCall | null {
  if (!structurallyValid(safeTx)) return null;
  try {
    return decodeSafeCall(systemAddresses(snapshot), safe, {
      to: safeTx.to,
      value: safeTx.value,
      data: safeTx.data,
      operation: safeTx.operation,
    });
  } catch (error) {
    if (error instanceof UndecodableCallError) return null;
    throw error;
  }
}

export function evaluatePolicy(snapshot: BackendPolicySnapshot, input: PolicyInput): PolicyVerdict {
  const call = decodeOperation(snapshot, input.safe, input.safeTx);
  if (call === null) return reject('UNKNOWN_OPERATION');
  const type = classifyCall(snapshot, call, input.facts);
  if (type === null) return reject('UNKNOWN_OPERATION');
  if (type !== input.declaredType) return reject('OPERATION_TYPE_MISMATCH', `es ${type}`);
  if (SCOPE_OF_ROLE[input.role] !== input.scope || !snapshot.operations[input.role].includes(type)) {
    return reject('OPERATION_NOT_ALLOWED');
  }
  const verdict = evaluateType(snapshot, input, call, type);
  return (
    verdict ?? {
      verdict: 'ACCEPT',
      type,
      call,
      outflow: type === 'SEND' && call.kind === 'ERC20_TRANSFER' ? call.amount : 0n,
    }
  );
}

function evaluateType(
  snapshot: BackendPolicySnapshot,
  input: PolicyInput,
  call: DecodedCall,
  type: OperationKind,
): PolicyVerdict | null {
  const { facts, safe } = input;
  const limits = snapshot.limits;
  switch (type) {
    case 'SEND': {
      if (call.kind !== 'ERC20_TRANSFER') return reject('UNKNOWN_OPERATION');
      if (forbiddenDestination(snapshot, safe, call.recipient)) return reject('DESTINATION_FORBIDDEN');
      if (call.amount < limits.minPerOperation || call.amount === 0n) return reject('BELOW_MINIMUM');
      if (call.amount > limits.perOperationMax) return reject('LIMIT_PER_OPERATION');
      if (facts.dailyOutflowUsed + call.amount > limits.dailyOutflowMax) return reject('LIMIT_DAILY');
      if (facts.destinationWhitelisted !== true) return reject('DESTINATION_NOT_WHITELISTED');
      if (facts.balance === undefined || facts.balance < call.amount) return reject('INSUFFICIENT_BALANCE');
      if (call.amount >= limits.twoFactorThreshold && facts.twoFactorVerified !== true) {
        return reject('TWO_FACTOR_REQUIRED');
      }
      return null;
    }
    case 'MIGRATION_TRANSFER': {
      if (call.kind !== 'ERC20_TRANSFER') return reject('UNKNOWN_OPERATION');
      if (forbiddenDestination(snapshot, safe, call.recipient)) return reject('DESTINATION_FORBIDDEN');
      // Exenta del tope de 24 h, pero transfiere el saldo completo del token.
      if (facts.balance === undefined || call.amount !== facts.balance || call.amount === 0n) {
        return reject('MIGRATION_PARTIAL');
      }
      return null;
    }
    case 'SWAP_APPROVE': {
      if (call.kind !== 'ERC20_APPROVE') return reject('UNKNOWN_OPERATION');
      const paired = facts.pairedSwap;
      if (!paired) return reject('SWAP_PAIRING_INVALID', 'falta el SWAP N+1');
      const swap = decodeOperation(snapshot, safe, paired.safeTx);
      if (
        swap?.kind !== 'SWAP' ||
        !paired.ownerSignatureValid ||
        paired.safeTx.nonce !== input.safeTx.nonce + 1n ||
        !isAddressEqual(swap.tokenInAddress, call.tokenAddress) ||
        swap.amountIn !== call.amount
      ) {
        return reject('SWAP_PAIRING_INVALID');
      }
      if (slippageBps(swap.amountIn, swap.minAmountOut) > BigInt(snapshot.swap.maxSlippageBps)) {
        return reject('SLIPPAGE_TOO_HIGH');
      }
      if (call.amount > limits.swapMax) return reject('SWAP_LIMIT');
      if (call.amount < limits.minPerOperation) return reject('BELOW_MINIMUM');
      if (facts.balance === undefined || facts.balance < call.amount) return reject('INSUFFICIENT_BALANCE');
      return null;
    }
    case 'SWAP': {
      if (call.kind !== 'SWAP') return reject('UNKNOWN_OPERATION');
      if (call.amountIn > limits.swapMax) return reject('SWAP_LIMIT');
      if (call.amountIn < limits.minPerOperation) return reject('BELOW_MINIMUM');
      if (slippageBps(call.amountIn, call.minAmountOut) > BigInt(snapshot.swap.maxSlippageBps)) {
        return reject('SLIPPAGE_TOO_HIGH');
      }
      const deadline = Number(call.deadline);
      if (deadline < facts.now || deadline > facts.now + snapshot.swap.deadlineSeconds) {
        return reject('DEADLINE_INVALID');
      }
      if (facts.approvalSigned !== true || facts.allowance !== call.amountIn) return reject('SWAP_PAIRING_INVALID');
      return null;
    }
    case 'APPROVE_REVOKE':
    case 'WHITELIST_REMOVE':
    case 'NOOP_CANCEL':
      return null;
    case 'WHITELIST_ADD': {
      if (call.kind !== 'WHITELIST_ADD') return reject('UNKNOWN_OPERATION');
      if (forbiddenDestination(snapshot, safe, call.destination)) return reject('DESTINATION_FORBIDDEN');
      if (facts.whitelistChallengeVerified !== true) return reject('CHALLENGE_REQUIRED');
      return null;
    }
    case 'ROTATION_PROPOSE':
      return call.kind === 'ROTATION_PROPOSE' ? evaluateProposal(snapshot, input, call) : reject('UNKNOWN_OPERATION');
    case 'ROTATION_EXECUTE':
      return call.kind === 'SWAP_OWNER' ? evaluateExecution(input, call) : reject('UNKNOWN_OPERATION');
    case 'GUARD_UPGRADE': {
      if (facts.successorRegistered !== true || facts.guardUpgradeMature !== true) {
        return reject('GUARD_UPGRADE_INVALID');
      }
      return null;
    }
  }
}

function roleKey(facts: PolicyFacts, kind: number): Address | undefined {
  if (kind === RotationKind.User) return facts.roles.userKey;
  if (kind === RotationKind.Recovery) return facts.roles.recoveryKey;
  if (kind === RotationKind.Executor) return facts.roles.executor;
  return undefined;
}

function isOwner(facts: PolicyFacts, address: Address): boolean {
  return [facts.roles.userKey, facts.roles.recoveryKey, facts.roles.executor].some((a) => isAddressEqual(a, address));
}

function evaluateProposal(
  snapshot: BackendPolicySnapshot,
  input: PolicyInput,
  call: Extract<DecodedCall, { kind: 'ROTATION_PROPOSE' }>,
): PolicyVerdict | null {
  const { facts } = input;
  const kind = call.rotationKind;
  // R sólo propone el reemplazo de U (recuperación) o de S ([W-07]).
  if (input.role === 'R' && kind !== RotationKind.User && kind !== RotationKind.Executor) {
    return reject('ROTATION_INVALID', 'R sólo propone U o S');
  }
  if (kind === RotationKind.Guard || kind === RotationKind.ModuleGuard) {
    const current = kind === RotationKind.Guard ? facts.currentGuard : facts.currentModuleGuard;
    if (current === undefined || !isAddressEqual(call.oldValue, current)) return reject('ROTATION_INVALID');
    if (facts.successorRegistered !== true) return reject('GUARD_UPGRADE_INVALID');
    return null;
  }
  const current = roleKey(facts, kind);
  if (current === undefined || !isAddressEqual(call.oldValue, current)) return reject('ROTATION_INVALID');
  const next = call.newValue;
  if (
    isAddressEqual(next, ZERO) ||
    isAddressEqual(next, SENTINEL) ||
    isOwner(facts, next) ||
    isAddressEqual(next, input.safe) ||
    isSystemAddress(snapshot, next)
  ) {
    return reject('ROTATION_INVALID');
  }
  if (kind === RotationKind.Executor) {
    return facts.newKeyIsSignerKey === true ? null : reject('ROTATION_TARGET_NOT_SIGNER_KEY');
  }
  return facts.keyAcceptanceValid === true ? null : reject('KEY_ACCEPTANCE_REQUIRED');
}

function evaluateExecution(
  input: PolicyInput,
  call: Extract<DecodedCall, { kind: 'SWAP_OWNER' }>,
): PolicyVerdict | null {
  const { facts } = input;
  const roleOf = (address: Address): 'U' | 'R' | 'S' | null => {
    if (isAddressEqual(address, facts.roles.userKey)) return 'U';
    if (isAddressEqual(address, facts.roles.recoveryKey)) return 'R';
    if (isAddressEqual(address, facts.roles.executor)) return 'S';
    return null;
  };
  const rotated = roleOf(call.oldOwner);
  if (rotated === null) return reject('ROTATION_INVALID', 'oldOwner no es un rol vigente');
  // R ejecuta la recuperación de U o el reemplazo de S, nunca su propia rotación.
  if (input.role === 'R' && rotated === 'R') return reject('ROTATION_INVALID');
  if (facts.prevOwnerCorrect !== true) return reject('ROTATION_INVALID', 'prevOwner incorrecto');
  if (facts.rotationExecutable !== true) return reject('ROTATION_NOT_EXECUTABLE');
  if (rotated === 'S') return facts.newKeyIsSignerKey === true ? null : reject('ROTATION_TARGET_NOT_SIGNER_KEY');
  return facts.keyAcceptanceValid === true ? null : reject('KEY_ACCEPTANCE_REQUIRED');
}

export type { Hex };
