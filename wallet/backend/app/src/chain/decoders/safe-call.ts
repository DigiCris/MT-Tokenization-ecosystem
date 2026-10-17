// Decoder tipificado de la llamada interna de una SafeTx (to, value, data, operation) [B-POL-03/04]. Decodifica
// desde los bytes, nunca desde descripciones del cliente, y es estricto: sólo CALL sin ETH, sólo destinos y
// selectores conocidos del sistema, y la calldata debe ser exactamente la codificación canónica (sin bytes extra).
// El mapeo a tipos de operación y los permisos por rol los decide la policy (P13).
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddressEqual,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { destinationWhitelistAbi, iSafeAbi, rotationTimelockAbi, swapExecutorV3Abi } from '../abis/index.ts';
import { RotationKind, SafeOperation, type RotationKindValue, type SystemAddresses } from '../constants.ts';

export type TokenSymbol = 'USDC' | 'USDT';

export type DecodedCall =
  | { kind: 'NOOP' }
  | { kind: 'ERC20_TRANSFER'; token: TokenSymbol; tokenAddress: Address; recipient: Address; amount: bigint }
  | { kind: 'ERC20_APPROVE'; token: TokenSymbol; tokenAddress: Address; spender: Address; amount: bigint }
  | {
      kind: 'SWAP';
      executor: Address;
      tokenIn: TokenSymbol;
      tokenInAddress: Address;
      tokenOut: TokenSymbol;
      amountIn: bigint;
      minAmountOut: bigint;
      deadline: bigint;
    }
  | { kind: 'WHITELIST_ADD'; destination: Address }
  | { kind: 'WHITELIST_REMOVE'; destination: Address }
  | { kind: 'ROTATION_PROPOSE'; rotationKind: RotationKindValue; oldValue: Address; newValue: Address }
  | { kind: 'ROTATION_CANCEL'; proposalId: Hex }
  | { kind: 'SWAP_OWNER'; prevOwner: Address; oldOwner: Address; newOwner: Address }
  | { kind: 'SET_GUARD'; guard: Address }
  | { kind: 'SET_MODULE_GUARD'; moduleGuard: Address };

export type UndecodableReason =
  | 'DELEGATECALL'
  | 'NONZERO_VALUE'
  | 'UNKNOWN_TARGET'
  | 'UNKNOWN_SELECTOR'
  | 'NON_CANONICAL_CALLDATA'
  | 'UNSUPPORTED_TOKEN'
  | 'INVALID_ROTATION_KIND';

export class UndecodableCallError extends Error {
  override name = 'UndecodableCallError';
  readonly reason: UndecodableReason;

  constructor(reason: UndecodableReason) {
    super(`llamada no decodificable (${reason})`);
    this.reason = reason;
  }
}

export interface SafeCall {
  to: Address;
  value: bigint;
  data: Hex;
  operation: number;
}

function strictDecode(abi: Abi, data: Hex, allowed: readonly string[]) {
  let decoded: { functionName: string; args: readonly unknown[] | undefined };
  try {
    decoded = decodeFunctionData({ abi, data });
  } catch {
    throw new UndecodableCallError('UNKNOWN_SELECTOR');
  }
  if (!allowed.includes(decoded.functionName)) throw new UndecodableCallError('UNKNOWN_SELECTOR');
  const reencoded = encodeFunctionData({ abi, functionName: decoded.functionName, args: decoded.args });
  if (reencoded.toLowerCase() !== data.toLowerCase()) throw new UndecodableCallError('NON_CANONICAL_CALLDATA');
  return { functionName: decoded.functionName, args: decoded.args ?? [] };
}

function tokenSymbol(system: SystemAddresses, address: Address): TokenSymbol | undefined {
  if (isAddressEqual(address, system.usdc)) return 'USDC';
  if (isAddressEqual(address, system.usdt)) return 'USDT';
  return undefined;
}

const ROTATION_KINDS = new Set<number>(Object.values(RotationKind));

export function decodeSafeCall(system: SystemAddresses, safe: Address, call: SafeCall): DecodedCall {
  if (call.operation !== SafeOperation.Call) throw new UndecodableCallError('DELEGATECALL');
  if (call.value !== 0n) throw new UndecodableCallError('NONZERO_VALUE');
  const to = getAddress(call.to);

  if (isAddressEqual(to, safe)) {
    if (call.data === '0x') return { kind: 'NOOP' };
    const { functionName, args } = strictDecode(iSafeAbi, call.data, ['swapOwner', 'setGuard', 'setModuleGuard']);
    if (functionName === 'swapOwner') {
      const [prevOwner, oldOwner, newOwner] = args as [Address, Address, Address];
      return { kind: 'SWAP_OWNER', prevOwner, oldOwner, newOwner };
    }
    if (functionName === 'setGuard') return { kind: 'SET_GUARD', guard: (args as [Address])[0] };
    return { kind: 'SET_MODULE_GUARD', moduleGuard: (args as [Address])[0] };
  }

  const token = tokenSymbol(system, to);
  if (token) {
    const { functionName, args } = strictDecode(erc20Abi, call.data, ['transfer', 'approve']);
    const [counterparty, amount] = args as [Address, bigint];
    return functionName === 'transfer'
      ? { kind: 'ERC20_TRANSFER', token, tokenAddress: to, recipient: counterparty, amount }
      : { kind: 'ERC20_APPROVE', token, tokenAddress: to, spender: counterparty, amount };
  }

  if (isAddressEqual(to, system.swapExecutor)) {
    const { args } = strictDecode(swapExecutorV3Abi, call.data, ['swap']);
    const [tokenInAddress, amountIn, minAmountOut, deadline] = args as [Address, bigint, bigint, bigint];
    const tokenIn = tokenSymbol(system, tokenInAddress);
    if (!tokenIn) throw new UndecodableCallError('UNSUPPORTED_TOKEN');
    return {
      kind: 'SWAP',
      executor: to,
      tokenIn,
      tokenInAddress,
      tokenOut: tokenIn === 'USDC' ? 'USDT' : 'USDC',
      amountIn,
      minAmountOut,
      deadline,
    };
  }

  if (isAddressEqual(to, system.destinationWhitelist)) {
    const { functionName, args } = strictDecode(destinationWhitelistAbi, call.data, [
      'addDestination',
      'removeDestination',
    ]);
    const destination = (args as [Address])[0];
    return functionName === 'addDestination'
      ? { kind: 'WHITELIST_ADD', destination }
      : { kind: 'WHITELIST_REMOVE', destination };
  }

  if (isAddressEqual(to, system.rotationTimelock)) {
    const { functionName, args } = strictDecode(rotationTimelockAbi, call.data, ['propose', 'cancel']);
    if (functionName === 'cancel') return { kind: 'ROTATION_CANCEL', proposalId: (args as [Hex])[0] };
    const [kind, oldValue, newValue] = args as [number, Address, Address];
    if (!ROTATION_KINDS.has(kind)) throw new UndecodableCallError('INVALID_ROTATION_KIND');
    return { kind: 'ROTATION_PROPOSE', rotationKind: kind as RotationKindValue, oldValue, newValue };
  }

  throw new UndecodableCallError('UNKNOWN_TARGET');
}
