// Detalles técnicos de una SafeTx para el desplegable del review (P18.MAN): contrato llamado, valor, tipo de llamada,
// función y argumentos decodificados de los bytes con los ABIs fijados, número de orden en la Safe y el hash que firma
// U. Es lo mismo que la frase del review, para quien quiera comprobarlo contra un explorador o su propia herramienta.
// Los montos van como los recibe el contrato (en unidades mínimas del token) y con su equivalente en es-AR al lado; el
// plazo del swap, con su fecha.
import { decodeFunctionData, erc20Abi, getAddress, isAddressEqual, type Abi, type Address, type Hex } from 'viem';
import type { TokenSymbol } from '../api/wallet-api.ts';
import { destinationWhitelistAbi } from '../chain/abis/DestinationWhitelist.ts';
import { iSafeAbi } from '../chain/abis/ISafe.ts';
import { rotationTimelockAbi } from '../chain/abis/RotationTimelock.ts';
import { securityGuardAbi } from '../chain/abis/SecurityGuard.ts';
import { swapExecutorV3Abi } from '../chain/abis/SwapExecutorV3.ts';
import type { DecodeContext } from '../chain/decoders.ts';
import type { SafeTx } from '../chain/safe-tx.ts';
import { tokenAmount } from './describe.ts';

export interface TechnicalArgument {
  name: string;
  type: string;
  value: string;
  /** Qué significa el valor crudo (p. ej. un monto en unidades mínimas y su equivalente). */
  note?: string;
}

export interface TechnicalCall {
  to: Address;
  value: bigint;
  /** 0 = CALL (lo único que acepta el camino asistido), 1 = DELEGATECALL. */
  operation: 0 | 1;
  /** null: sin datos (la operación vacía) o una función que la app no conoce. */
  signature: string | null;
  args: TechnicalArgument[];
  data: Hex;
  nonce: bigint;
}

/** El ABI del contrato al que apunta la SafeTx, si es uno de los que usa el camino asistido. */
function abiFor(to: Address, ctx: DecodeContext): Abi | null {
  const c = ctx.system.contracts;
  const is = (address: Address | undefined) => address !== undefined && isAddressEqual(to, address);
  if (is(ctx.chain.tokens.usdc.address) || is(ctx.chain.tokens.usdt.address)) return erc20Abi;
  if (is(ctx.safe)) return iSafeAbi;
  if (is(c.swapExecutor.address)) return swapExecutorV3Abi;
  if (is(c.whitelist.address)) return destinationWhitelistAbi;
  if (is(c.timelock.address)) return rotationTimelockAbi;
  if (is(c.guard.address)) return securityGuardAbi;
  return null;
}

function symbolOf(address: unknown, ctx: DecodeContext): TokenSymbol | null {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  if (isAddressEqual(address as Address, ctx.chain.tokens.usdc.address)) return 'USDC';
  if (isAddressEqual(address as Address, ctx.chain.tokens.usdt.address)) return 'USDT';
  return null;
}

const unitsNote = (units: bigint, token: TokenSymbol) =>
  `= ${tokenAmount(units, token)} (el contrato recibe el monto en unidades mínimas: ${token} tiene 6 decimales)`;

/** Notas de los argumentos que no se leen solos: montos en unidades mínimas y el plazo del swap en segundos. */
function noteFor(
  to: Address,
  functionName: string,
  name: string,
  value: unknown,
  args: readonly unknown[],
  ctx: DecodeContext,
): string | undefined {
  if (typeof value !== 'bigint') return undefined;
  const token = symbolOf(to, ctx);
  if (token !== null && (functionName === 'transfer' || functionName === 'approve') && name === 'amount') {
    return unitsNote(value, token);
  }
  if (isAddressEqual(to, ctx.system.contracts.swapExecutor.address) && functionName === 'swap') {
    const tokenIn = symbolOf(args[0], ctx);
    if (tokenIn !== null && name === 'amountIn') return unitsNote(value, tokenIn);
    if (tokenIn !== null && name === 'minAmountOut') return unitsNote(value, tokenIn === 'USDC' ? 'USDT' : 'USDC');
    if (name === 'deadline') {
      return `= ${new Date(Number(value) * 1000).toLocaleString('es-AR')} (hora de la cadena, en segundos desde 1970)`;
    }
  }
  return undefined;
}

function argumentText(value: unknown): string {
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return /^0x[0-9a-fA-F]{40}$/.test(value) ? getAddress(value) : value;
  return JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner));
}

export function technicalCall(tx: SafeTx, ctx: DecodeContext): TechnicalCall {
  const base = { to: tx.to, value: tx.value, operation: tx.operation, data: tx.data, nonce: tx.nonce };
  if (tx.data === '0x') return { ...base, signature: null, args: [] };
  const abi = abiFor(tx.to, ctx);
  if (abi === null) return { ...base, signature: null, args: [] };
  try {
    const decoded = decodeFunctionData({ abi, data: tx.data });
    const item = abi.find(
      (entry) =>
        entry.type === 'function' &&
        entry.name === decoded.functionName &&
        entry.inputs.length === (decoded.args?.length ?? 0),
    );
    const inputs = item?.type === 'function' ? item.inputs : [];
    const values: readonly unknown[] = decoded.args ?? [];
    const args = values.map((value, i) => {
      const name = inputs[i]?.name ?? `arg${String(i)}`;
      const note = noteFor(tx.to, decoded.functionName, name, value, values, ctx);
      return {
        name,
        type: inputs[i]?.type ?? '?',
        value: argumentText(value),
        ...(note === undefined ? {} : { note }),
      };
    });
    const signature = `${decoded.functionName}(${args.map((a) => `${a.type} ${a.name}`).join(', ')})`;
    return { ...base, signature, args };
  } catch {
    return { ...base, signature: null, args: [] };
  }
}
