// Reglas estáticas restrictivas [B-SIG-06] (P11.T05): se evalúan ANTES de cualquier lectura on-chain o de la DB y sólo
// dependen del pedido y del snapshot firmado (nunca de datos "explicativos" del backend). Cada regla tiene un id
// estable (SR-xx para la SafeTx y la tx de S, GT-xx para la cuenta gas tank) que aparece en el error y en la tabla de
// rechazos de los tests.
//
// La SafeTx se clasifica desde sus bytes en una operación tipificada V1 [B-POL-03]; cualquier otra cosa se rechaza:
// sin DELEGATECALL, sin ETH, sin parámetros de gas/refund, sin destinos ni selectores fuera de la allowlist del
// sistema y con calldata de longitud exacta.
import { bytesToHex, type Hex, hexToBytes } from '../crypto/bytes.ts';
import { sameAddress, type Address } from '../crypto/keccak.ts';
import { CalldataError, decodeStatic, SELECTORS, selectorOfCalldata } from '../chain/abi.ts';
import type { SafeTx } from '../chain/safe-tx.ts';
import { ROTATION_KINDS, type OperationType, type RotationKind } from './operations.ts';
import type { PolicySnapshot } from './snapshot.ts';

export const BASE_CHAIN_ID = 8453;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
export const SENTINEL_ADDRESS = '0x0000000000000000000000000000000000000001' as Address;

export type StaticRuleId =
  | 'SR-01'
  | 'SR-02'
  | 'SR-03'
  | 'SR-04'
  | 'SR-05'
  | 'SR-06'
  | 'SR-07'
  | 'SR-08'
  | 'SR-09'
  | 'SR-10'
  | 'SR-11'
  | 'SR-12'
  | 'SR-13'
  | 'SR-14'
  | 'GT-01'
  | 'GT-02'
  | 'GT-03'
  | 'GT-04'
  | 'GT-05'
  | 'GT-06';

/** Descripción de cada regla (la tabla que se revisa línea por línea en P11.MAN). */
export const STATIC_RULES: Readonly<Record<StaticRuleId, string>> = {
  'SR-01': 'chainId del pedido y del snapshot == 8453',
  'SR-02': 'operation == 0 (CALL; nunca DELEGATECALL)',
  'SR-03': 'safeTxGas == baseGas == gasPrice == 0',
  'SR-04': 'gasToken == refundReceiver == address(0)',
  'SR-05': 'value == 0 (V1 no mueve ETH por camino asistido)',
  'SR-06': 'destino y selector dentro de la allowlist del sistema (tokens, SwapExecutor, whitelist, timelock, la Safe)',
  'SR-07': 'calldata canónica de longitud exacta',
  'SR-08': 'tipo de operación declarado == tipo decodificado de los bytes',
  'SR-09': 'Safe distinta de address(0) y de los contratos del sistema',
  'SR-10': 'tx de S: to == Safe asociada',
  'SR-11': 'tx de S: selector execTransaction',
  'SR-12': 'tx de S: value == 0',
  'SR-13': 'tx de S: chainId == 8453',
  'SR-14': 'tx de S: maxFeePerGas, maxPriorityFeePerGas y gas dentro de los topes del snapshot',
  'GT-01': 'tx del gas tank: chainId == 8453',
  'GT-02': 'recarga: transferencia de ETH sin calldata, 0 < value ≤ tope por recarga, destino ≠ address(0)',
  'GT-03': 'deploy: WalletFactory.createWallet(address,address,address,uint256) con value 0 y calldata exacta',
  'GT-04':
    'relay: RotationTimelock.cancelWithSignature(bytes32,bytes) con value 0, firma de 65 bytes y calldata exacta',
  'GT-05': 'tx del gas tank: maxFeePerGas, maxPriorityFeePerGas y gas dentro de los topes del snapshot',
  'GT-06': 'tx del gas tank: ningún otro destino ni selector',
};

export class StaticRuleViolation extends Error {
  override name = 'StaticRuleViolation';
  readonly rule: StaticRuleId;

  constructor(rule: StaticRuleId, detail?: string) {
    super(`regla estática ${rule}: ${STATIC_RULES[rule]}${detail === undefined ? '' : ` (${detail})`}`);
    this.rule = rule;
  }
}

export type TypedOperation =
  | { type: 'NOOP_CANCEL' }
  | { type: 'TRANSFER'; token: Address; destination: Address; amount: bigint }
  | { type: 'SWAP_APPROVE' | 'APPROVE_REVOKE'; token: Address; spender: Address; amount: bigint }
  | { type: 'SWAP'; executor: Address; tokenIn: Address; amountIn: bigint; minAmountOut: bigint; deadline: bigint }
  | { type: 'WHITELIST_ADD' | 'WHITELIST_REMOVE'; destination: Address }
  | { type: 'ROTATION_PROPOSE'; kind: RotationKind; oldValue: Address; newValue: Address }
  | { type: 'ROTATION_EXECUTE'; prevOwner: Address; oldOwner: Address; newOwner: Address }
  | { type: 'GUARD_UPGRADE'; target: 'GUARD' | 'MODULE_GUARD'; newValue: Address };

/** Tipos declarables que corresponden a cada operación decodificada (TRANSFER puede ser SEND o MIGRATION_TRANSFER). */
function declaredMatches(declared: OperationType, op: TypedOperation): boolean {
  if (op.type === 'TRANSFER') return declared === 'SEND' || declared === 'MIGRATION_TRANSFER';
  return declared === op.type;
}

export function systemAddresses(snapshot: PolicySnapshot): Address[] {
  return [...Object.values(snapshot.contracts), ...snapshot.tokens.map((t) => t.address)] as Address[];
}

function isToken(snapshot: PolicySnapshot, address: Address): boolean {
  return snapshot.tokens.some((t) => sameAddress(t.address, address));
}

/**
 * Clasifica la SafeTx desde sus bytes (SR-02..SR-08). Lanza StaticRuleViolation si no es una operación V1 dentro de la
 * allowlist del snapshot.
 */
export function classifySafeTx(snapshot: PolicySnapshot, safe: Address, tx: SafeTx): TypedOperation {
  if (tx.operation !== 0) throw new StaticRuleViolation('SR-02');
  if (tx.safeTxGas !== 0n || tx.baseGas !== 0n || tx.gasPrice !== 0n) throw new StaticRuleViolation('SR-03');
  if (!sameAddress(tx.gasToken, ZERO_ADDRESS) || !sameAddress(tx.refundReceiver, ZERO_ADDRESS)) {
    throw new StaticRuleViolation('SR-04');
  }
  if (tx.value !== 0n) throw new StaticRuleViolation('SR-05');
  let data: Uint8Array;
  let selector: Hex | null;
  try {
    data = hexToBytes(tx.data);
    selector = selectorOfCalldata(data);
  } catch {
    throw new StaticRuleViolation('SR-07', 'calldata inválida');
  }
  try {
    const c = snapshot.contracts;
    if (sameAddress(tx.to, safe)) {
      if (selector === null) return { type: 'NOOP_CANCEL' };
      if (selector === SELECTORS.swapOwner) {
        const [prevOwner, oldOwner, newOwner] = decodeStatic(data, SELECTORS.swapOwner, [
          'address',
          'address',
          'address',
        ]);
        return { type: 'ROTATION_EXECUTE', prevOwner, oldOwner, newOwner };
      }
      if (selector === SELECTORS.setGuard) {
        const [newValue] = decodeStatic(data, SELECTORS.setGuard, ['address']);
        return { type: 'GUARD_UPGRADE', target: 'GUARD', newValue };
      }
      if (selector === SELECTORS.setModuleGuard) {
        const [newValue] = decodeStatic(data, SELECTORS.setModuleGuard, ['address']);
        return { type: 'GUARD_UPGRADE', target: 'MODULE_GUARD', newValue };
      }
      throw new StaticRuleViolation('SR-06', 'llamada a la propia Safe fuera de la allowlist');
    }
    if (isToken(snapshot, tx.to)) {
      if (selector === SELECTORS.transfer) {
        const [destination, amount] = decodeStatic(data, SELECTORS.transfer, ['address', 'uint256']);
        return { type: 'TRANSFER', token: tx.to, destination, amount };
      }
      if (selector === SELECTORS.approve) {
        const [spender, amount] = decodeStatic(data, SELECTORS.approve, ['address', 'uint256']);
        // Autoridad económica [C-DEC-03]/[C-GRD-07]: approve sólo hacia el SwapExecutor registrado.
        if (!sameAddress(spender, c.swapExecutor)) throw new StaticRuleViolation('SR-06', 'approve a otro spender');
        return { type: amount === 0n ? 'APPROVE_REVOKE' : 'SWAP_APPROVE', token: tx.to, spender, amount };
      }
      throw new StaticRuleViolation('SR-06', 'selector de token fuera de la allowlist');
    }
    if (sameAddress(tx.to, c.swapExecutor)) {
      if (selector !== SELECTORS.swap) throw new StaticRuleViolation('SR-06', 'selector del SwapExecutor');
      const [tokenIn, amountIn, minAmountOut, deadline] = decodeStatic(data, SELECTORS.swap, [
        'address',
        'uint256',
        'uint256',
        'uint256',
      ]);
      if (!isToken(snapshot, tokenIn)) throw new StaticRuleViolation('SR-06', 'tokenIn no soportado');
      return { type: 'SWAP', executor: tx.to, tokenIn, amountIn, minAmountOut, deadline };
    }
    if (sameAddress(tx.to, c.destinationWhitelist)) {
      if (selector === SELECTORS.addDestination) {
        const [destination] = decodeStatic(data, SELECTORS.addDestination, ['address']);
        return { type: 'WHITELIST_ADD', destination };
      }
      if (selector === SELECTORS.removeDestination) {
        const [destination] = decodeStatic(data, SELECTORS.removeDestination, ['address']);
        return { type: 'WHITELIST_REMOVE', destination };
      }
      throw new StaticRuleViolation('SR-06', 'selector de la whitelist');
    }
    if (sameAddress(tx.to, c.rotationTimelock)) {
      if (selector !== SELECTORS.propose) throw new StaticRuleViolation('SR-06', 'selector del timelock');
      const [kind, oldValue, newValue] = decodeStatic(data, SELECTORS.propose, ['uint8', 'address', 'address']);
      const name = ROTATION_KINDS[Number(kind) as keyof typeof ROTATION_KINDS] as RotationKind | undefined;
      if (name === undefined) throw new StaticRuleViolation('SR-07', 'tipo de rotación desconocido');
      return { type: 'ROTATION_PROPOSE', kind: name, oldValue, newValue };
    }
    throw new StaticRuleViolation('SR-06', 'destino fuera de la allowlist del sistema');
  } catch (error) {
    if (error instanceof CalldataError) throw new StaticRuleViolation('SR-07', error.message);
    throw error;
  }
}

/** SR-01, SR-09 y SR-02..SR-08 sobre la SafeTx de un pedido de firma. */
export function checkSafeTxStatic(
  snapshot: PolicySnapshot,
  request: { chainId: number; safe: Address; safeTx: SafeTx; operationType: OperationType },
): TypedOperation {
  // El schema del snapshot ya fija chainId 8453.
  if (request.chainId !== BASE_CHAIN_ID) throw new StaticRuleViolation('SR-01');
  if (sameAddress(request.safe, ZERO_ADDRESS) || systemAddresses(snapshot).some((a) => sameAddress(a, request.safe))) {
    throw new StaticRuleViolation('SR-09');
  }
  const op = classifySafeTx(snapshot, request.safe, request.safeTx);
  if (!declaredMatches(request.operationType, op)) {
    throw new StaticRuleViolation('SR-08', `declarado ${request.operationType}, decodificado ${op.type}`);
  }
  return op;
}

export interface FeeParams {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
}

/** SR-10..SR-14: la tx EIP-1559 que firma S (la arma el signer, igual se verifica antes de firmar). */
export function checkExecutorTxStatic(
  snapshot: PolicySnapshot,
  tx: { chainId: number; to: Address; value: bigint; data: Hex } & FeeParams,
  safe: Address,
): void {
  if (!sameAddress(tx.to, safe)) throw new StaticRuleViolation('SR-10');
  if (!tx.data.toLowerCase().startsWith(SELECTORS.execTransaction)) throw new StaticRuleViolation('SR-11');
  if (tx.value !== 0n) throw new StaticRuleViolation('SR-12');
  if (tx.chainId !== BASE_CHAIN_ID) throw new StaticRuleViolation('SR-13');
  checkFees('SR-14', tx, snapshot.gas.maxFeePerGasWei, snapshot.gas.maxPriorityFeePerGasWei, snapshot.gas.maxGasLimit);
}

function checkFees(
  rule: 'SR-14' | 'GT-05',
  fees: FeeParams,
  maxFee: bigint,
  maxPriority: bigint,
  maxGas: number,
): void {
  if (fees.maxFeePerGas <= 0n || fees.maxFeePerGas > maxFee) throw new StaticRuleViolation(rule, 'maxFeePerGas');
  if (fees.maxPriorityFeePerGas < 0n || fees.maxPriorityFeePerGas > maxPriority) {
    throw new StaticRuleViolation(rule, 'maxPriorityFeePerGas');
  }
  if (fees.maxPriorityFeePerGas > fees.maxFeePerGas) throw new StaticRuleViolation(rule, 'priority > max fee');
  if (fees.gasLimit < 21_000n || fees.gasLimit > BigInt(maxGas)) throw new StaticRuleViolation(rule, 'gas');
}

export type PlatformTxPurposeDecoded =
  | { purpose: 'TOPUP'; to: Address; value: bigint }
  | { purpose: 'DEPLOY'; userKey: Address; recoveryKey: Address; executor: Address; saltNonce: bigint }
  | { purpose: 'CANCEL_RELAY'; proposalId: Hex; signature: Hex };

/**
 * GT-01..GT-06: lo único que puede firmar la cuenta gas tank [B-SIG-05]: recargas de ETH, `createWallet` y
 * `cancelWithSignature`. El destino de una recarga (una S registrada en el Guard) se verifica on-chain después.
 */
export function checkPlatformTxStatic(
  snapshot: PolicySnapshot,
  tx: {
    chainId: number;
    purpose: 'TOPUP' | 'DEPLOY' | 'CANCEL_RELAY';
    to: Address;
    value: bigint;
    data: Hex;
  } & FeeParams,
): PlatformTxPurposeDecoded {
  if (tx.chainId !== BASE_CHAIN_ID) throw new StaticRuleViolation('GT-01');
  checkFees(
    'GT-05',
    tx,
    snapshot.gas.maxFeePerGasWei,
    snapshot.gas.maxPriorityFeePerGasWei,
    snapshot.gasTank.maxGasLimit,
  );
  let data: Uint8Array;
  try {
    data = hexToBytes(tx.data);
  } catch {
    throw new StaticRuleViolation('GT-06', 'calldata inválida');
  }
  switch (tx.purpose) {
    case 'TOPUP':
      if (data.length !== 0 || tx.value <= 0n || tx.value > snapshot.gasTank.topupMaxWei) {
        throw new StaticRuleViolation('GT-02');
      }
      if (sameAddress(tx.to, ZERO_ADDRESS) || systemAddresses(snapshot).some((a) => sameAddress(a, tx.to))) {
        throw new StaticRuleViolation('GT-02', 'destino inválido');
      }
      return { purpose: 'TOPUP', to: tx.to, value: tx.value };
    case 'DEPLOY': {
      if (!sameAddress(tx.to, snapshot.contracts.walletFactory) || tx.value !== 0n) {
        throw new StaticRuleViolation('GT-03');
      }
      try {
        const [userKey, recoveryKey, executor, saltNonce] = decodeStatic(data, SELECTORS.createWallet, [
          'address',
          'address',
          'address',
          'uint256',
        ]);
        return { purpose: 'DEPLOY', userKey, recoveryKey, executor, saltNonce };
      } catch {
        throw new StaticRuleViolation('GT-03', 'calldata');
      }
    }
    case 'CANCEL_RELAY': {
      if (!sameAddress(tx.to, snapshot.contracts.rotationTimelock) || tx.value !== 0n) {
        throw new StaticRuleViolation('GT-04');
      }
      return decodeCancelWithSignature(data);
    }
  }
}

/** cancelWithSignature(bytes32 id, bytes signature): encoding canónico exacto con una firma de 65 bytes. */
function decodeCancelWithSignature(data: Uint8Array): PlatformTxPurposeDecoded {
  // selector + id + offset(0x40) + length(65) + 65 bytes con padding a 96.
  const expectedLength = 4 + 32 + 32 + 32 + 96;
  const hex = (b: Uint8Array): Hex => bytesToHex(b);
  if (data.length !== expectedLength || hex(data.subarray(0, 4)) !== SELECTORS.cancelWithSignature) {
    throw new StaticRuleViolation('GT-04', 'calldata');
  }
  const offset = BigInt(hex(data.subarray(36, 68)));
  const length = BigInt(hex(data.subarray(68, 100)));
  const padding = data.subarray(100 + 65);
  if (offset !== 0x40n || length !== 65n || padding.some((b) => b !== 0)) {
    throw new StaticRuleViolation('GT-04', 'firma no canónica');
  }
  return { purpose: 'CANCEL_RELAY', proposalId: hex(data.subarray(4, 36)), signature: hex(data.subarray(100, 165)) };
}
