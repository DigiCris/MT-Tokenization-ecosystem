// Rotaciones vistas desde los dos lados: la propuesta activa por tipo en el timelock on-chain y lo que sabe el backend
// (su sync de eventos tarda unos segundos en reflejar una propuesta o una cancelación).
import { expect } from '@playwright/test';
import type { Address, Hex } from 'viem';
import { rotationTimelockAbi } from '../../../frontend/recovery/src/chain/abis/RotationTimelock.ts';
import { chain } from './chain.ts';
import type { ActiveWallet } from './onboard.ts';
import { contract } from '../stack.ts';

export const ROTATION_KIND = { U: 0, R: 1, S: 2, GUARD: 3, MODULE_GUARD: 4 } as const;

export function activeProposal(safe: Address, kind: keyof typeof ROTATION_KIND): Promise<Hex> {
  return chain().readContract({
    address: contract('RotationTimelock'),
    abi: rotationTimelockAbi,
    functionName: 'activeProposal',
    args: [safe, ROTATION_KIND[kind]],
  });
}

interface RotationView {
  role: string;
  status: string;
  proposalId: Hex | null;
}

async function rotations(wallet: ActiveWallet): Promise<RotationView[]> {
  const { items } = await wallet.account.wallet.request<{ items: RotationView[] }>(
    'GET',
    `/wallets/${wallet.walletId}/rotations`,
  );
  return items;
}

/** El backend registró la propuesta on-chain (con su proposalId) para ese rol. */
export async function backendKnowsProposal(wallet: ActiveWallet, role: 'U' | 'S'): Promise<void> {
  await expect
    .poll(
      async () =>
        (await rotations(wallet)).some(
          (r) =>
            r.role === role && r.proposalId !== null && ['PENDING_TIMELOCK', 'READY_TO_EXECUTE'].includes(r.status),
        ),
      { timeout: 120_000 },
    )
    .toBe(true);
}

/** El backend ya no tiene rotaciones vivas de ese rol (vio la cancelación o la ejecución on-chain). */
export async function backendSettled(wallet: ActiveWallet, role: 'U' | 'S'): Promise<void> {
  await expect
    .poll(
      async () =>
        (await rotations(wallet)).filter(
          (r) => r.role === role && !['CANCELLED', 'EXECUTED', 'FAILED'].includes(r.status),
        ).length,
      { timeout: 120_000 },
    )
    .toBe(0);
}
