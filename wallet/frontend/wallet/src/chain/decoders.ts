// Decodificación de una SafeTx para el review (P18.T06/T07, [F-UI]): qué hace la operación, leído de los bytes con las
// direcciones fijadas en el build (tokens de chain.base.json y contratos del sistema) y la propia Safe. Lo que no es una
// llamada reconocida del camino asistido queda como UNKNOWN y la app no lo firma.
import { decodeFunctionData, erc20Abi, isAddressEqual, type Address, type Hex } from 'viem';
import type { RotationRole } from '../api/wallet-api.ts';
import type { PinnedChain } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';
import { destinationWhitelistAbi } from './abis/DestinationWhitelist.ts';
import { iSafeAbi } from './abis/ISafe.ts';
import { rotationTimelockAbi } from './abis/RotationTimelock.ts';
import { securityGuardAbi } from './abis/SecurityGuard.ts';
import { swapExecutorV3Abi } from './abis/SwapExecutorV3.ts';
import type { SafeTx } from './safe-tx.ts';

export type TokenSymbol = 'USDC' | 'USDT';

/** RotationKind del timelock ([C-RTL-02]): el orden del enum de contracts/src/libraries/Roles.sol. */
export const ROTATION_KINDS: readonly RotationRole[] = ['U', 'R', 'S', 'GUARD', 'MODULE_GUARD'];

export type DecodedCall =
  | { kind: 'NOOP' }
  | { kind: 'TRANSFER'; token: TokenSymbol; recipient: Address; amount: bigint }
  | { kind: 'APPROVE'; token: TokenSymbol; spender: Address; amount: bigint }
  | {
      kind: 'SWAP';
      tokenIn: TokenSymbol;
      tokenOut: TokenSymbol;
      amountIn: bigint;
      minAmountOut: bigint;
      deadline: bigint;
    }
  | { kind: 'WHITELIST_ADD' | 'WHITELIST_REMOVE'; destination: Address }
  | { kind: 'ROTATION_PROPOSE'; role: RotationRole; oldValue: Address; newValue: Address }
  | { kind: 'ROTATION_CANCEL'; proposalId: Hex }
  | { kind: 'ROTATION_EXECUTE'; prevOwner: Address; oldOwner: Address; newOwner: Address }
  | { kind: 'GUARD_UPGRADE'; target: 'GUARD' | 'MODULE_GUARD'; newGuard: Address }
  | { kind: 'GUARD_ROLES_UPDATE'; userKey: Address; recoveryKey: Address; executor: Address }
  | { kind: 'UNKNOWN'; reason: string };

export interface DecodeContext {
  safe: Address;
  chain: Pick<PinnedChain, 'tokens'>;
  system: Pick<SystemContracts, 'contracts'>;
}

function tokenAt(address: Address, chain: Pick<PinnedChain, 'tokens'>): TokenSymbol | null {
  if (isAddressEqual(address, chain.tokens.usdc.address)) return 'USDC';
  if (isAddressEqual(address, chain.tokens.usdt.address)) return 'USDT';
  return null;
}

function safely<T>(decode: () => T): T | null {
  try {
    return decode();
  } catch {
    return null;
  }
}

export function decodeSafeTx(tx: SafeTx, ctx: DecodeContext): DecodedCall {
  const unknown = (reason: string): DecodedCall => ({ kind: 'UNKNOWN', reason });
  if (tx.operation !== 0) return unknown('DELEGATECALL');
  if (tx.value !== 0n) return unknown('envía ETH');
  if (tx.safeTxGas !== 0n || tx.baseGas !== 0n || tx.gasPrice !== 0n) return unknown('reembolso de gas');
  const c = ctx.system.contracts;
  if (isAddressEqual(tx.to, ctx.safe)) {
    if (tx.data === '0x') return { kind: 'NOOP' };
    const call = safely(() => decodeFunctionData({ abi: iSafeAbi, data: tx.data }));
    if (call?.functionName === 'swapOwner') {
      const [prevOwner, oldOwner, newOwner] = call.args;
      return { kind: 'ROTATION_EXECUTE', prevOwner, oldOwner, newOwner };
    }
    if (call?.functionName === 'setGuard') return { kind: 'GUARD_UPGRADE', target: 'GUARD', newGuard: call.args[0] };
    if (call?.functionName === 'setModuleGuard') {
      return { kind: 'GUARD_UPGRADE', target: 'MODULE_GUARD', newGuard: call.args[0] };
    }
    return unknown('llamada a la Safe no reconocida');
  }
  const token = tokenAt(tx.to, ctx.chain);
  if (token !== null) {
    const call = safely(() => decodeFunctionData({ abi: erc20Abi, data: tx.data }));
    if (call?.functionName === 'transfer')
      return { kind: 'TRANSFER', token, recipient: call.args[0], amount: call.args[1] };
    if (call?.functionName === 'approve')
      return { kind: 'APPROVE', token, spender: call.args[0], amount: call.args[1] };
    return unknown('llamada al token no reconocida');
  }
  if (isAddressEqual(tx.to, c.swapExecutor.address)) {
    const call = safely(() => decodeFunctionData({ abi: swapExecutorV3Abi, data: tx.data }));
    if (call?.functionName !== 'swap') return unknown('llamada al SwapExecutor no reconocida');
    const [tokenInAddress, amountIn, minAmountOut, deadline] = call.args;
    const tokenIn = tokenAt(tokenInAddress, ctx.chain);
    if (tokenIn === null) return unknown('swap de un token que no es USDC ni USDT');
    return { kind: 'SWAP', tokenIn, tokenOut: tokenIn === 'USDC' ? 'USDT' : 'USDC', amountIn, minAmountOut, deadline };
  }
  if (isAddressEqual(tx.to, c.whitelist.address)) {
    const call = safely(() => decodeFunctionData({ abi: destinationWhitelistAbi, data: tx.data }));
    if (call?.functionName === 'addDestination') return { kind: 'WHITELIST_ADD', destination: call.args[0] };
    if (call?.functionName === 'removeDestination') return { kind: 'WHITELIST_REMOVE', destination: call.args[0] };
    return unknown('llamada a la whitelist no reconocida');
  }
  if (isAddressEqual(tx.to, c.timelock.address)) {
    const call = safely(() => decodeFunctionData({ abi: rotationTimelockAbi, data: tx.data }));
    if (call?.functionName === 'propose') {
      const [kind, oldValue, newValue] = call.args;
      const role = ROTATION_KINDS[kind];
      if (role === undefined) return unknown('tipo de rotación desconocido');
      return { kind: 'ROTATION_PROPOSE', role, oldValue, newValue };
    }
    if (call?.functionName === 'cancel') return { kind: 'ROTATION_CANCEL', proposalId: call.args[0] };
    return unknown('llamada al timelock no reconocida');
  }
  if (isAddressEqual(tx.to, c.guard.address)) {
    // Sólo por el camino soberano (U + R): `updateRoles` del Guard tras reemplazar a S.
    const call = safely(() => decodeFunctionData({ abi: securityGuardAbi, data: tx.data }));
    if (call?.functionName === 'updateRoles') {
      const [userKey, recoveryKey, executor] = call.args;
      return { kind: 'GUARD_ROLES_UPDATE', userKey, recoveryKey, executor };
    }
    return unknown('llamada al Guard no reconocida');
  }
  return unknown('destino fuera de los contratos del sistema');
}
