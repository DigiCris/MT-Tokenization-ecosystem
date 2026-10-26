// Fork de Base del stack, sólo para los tests (P22.T01): adelantar el reloj de la cadena (activación de 24 h de la
// whitelist, timelock de 48 h de las rotaciones) minando los bloques que la plataforma espera para dar por confirmado un
// evento, y fondear cuentas con USDC/USDT reales del fork (transferidos desde una cuenta con saldo, suplantada en
// Anvil) o con ETH para el gas. Nada de esto existe fuera del fork local.
import { type Address } from 'viem';
import { anvil, chain, fund, tokenBalance, USDC, USDC_HOLDER, USDT, USDT_HOLDER } from './wallet/chain.ts';

export { anvil, chain, tokenBalance, USDC, USDT };

/** Bloques que espera la plataforma para aplicar un evento de la cadena (CONFIRMATION_DEPTH de `.env.example`). */
export const CONFIRMATION_BLOCKS = 3;

/** Mina `count` bloques (en Anvil sólo hay bloques nuevos con transacciones; en Base llegan solos). */
export async function mine(count = CONFIRMATION_BLOCKS): Promise<void> {
  await anvil('anvil_mine', [`0x${count.toString(16)}`]);
}

/** Adelanta el reloj de la cadena y mina los bloques de confirmación con el timestamp nuevo. */
export async function increaseTime(seconds: number): Promise<void> {
  await anvil('evm_increaseTime', [seconds]);
  await mine();
}

/** Hora de la cadena (segundos del último bloque). */
export async function chainTime(): Promise<bigint> {
  return (await chain().getBlock()).timestamp;
}

/** USDC real del fork (6 decimales: `1_000_000n` = 1 USDC). */
export async function fundUsdc(to: Address, amount: bigint): Promise<void> {
  await fund(USDC, USDC_HOLDER, to, amount);
}

/** USDT real del fork (6 decimales). */
export async function fundUsdt(to: Address, amount: bigint): Promise<void> {
  await fund(USDT, USDT_HOLDER, to, amount);
}

/** ETH para el gas de una cuenta de prueba (relayer o wallet externa). */
export async function fundEth(to: Address, wei = 10n ** 18n): Promise<void> {
  await anvil('anvil_setBalance', [to, `0x${wei.toString(16)}`]);
}
