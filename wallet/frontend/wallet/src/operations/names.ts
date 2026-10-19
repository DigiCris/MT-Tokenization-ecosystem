// Nombres que la app conoce por dirección para el review y la actividad (P18.MAN): los contratos del sistema y los
// tokens fijados en el build, el pool de Uniswap fijado, la propia Safe y los labels de la whitelist (texto del usuario
// que vienen del backend). Un label nunca tapa a un contrato del sistema, y la dirección completa se muestra siempre al
// lado del nombre: el nombre ayuda a reconocerla, no la reemplaza.
import type { Address } from 'viem';
import type { WhitelistEntry, WhitelistRequest } from '../api/wallet-api.ts';
import type { PinnedChain } from '../config/chain.ts';
import type { SystemContracts, SystemRole } from '../config/system-contracts.ts';

export type NameOf = (address: Address) => string | null;

const SYSTEM_NAMES: Record<SystemRole, string> = {
  swapExecutor: 'el contrato de swap de la plataforma',
  whitelist: 'el contrato de la whitelist',
  timelock: 'el contrato de rotaciones (espera de 48 h)',
  guard: 'el Guard de seguridad',
  moduleGuard: 'el guard de módulos',
  policyRegistry: 'el registro de reglas de la plataforma',
  factory: 'la fábrica de Safes',
  bootstrap: 'el inicializador de Safes',
};

export const POOL_NAME = 'el pool USDC/USDT de Uniswap fijado';

export interface NamesContext {
  /** La Safe operativa ("tu Safe"). */
  safe?: Address;
  chain?: Partial<Pick<PinnedChain, 'tokens' | 'uniswap'>>;
  system?: Pick<SystemContracts, 'contracts'>;
}

/** Labels de la whitelist por dirección (minúsculas): lo que el usuario escribió al agregar cada destino. */
export function labelsOf(destinations: readonly { address: Address; label: string | null }[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const d of destinations) if (d.label) labels.set(d.address.toLowerCase(), d.label);
  return labels;
}

/** Los labels que guarda el backend: los de cada destino (aun quitado) y, si todavía no se indexó, los del pedido. */
export function backendLabels(backend: {
  entries: readonly WhitelistEntry[];
  requests?: readonly WhitelistRequest[];
}): Map<string, string> {
  const labels = new Map<string, string>();
  for (const r of backend.requests ?? []) if (r.label) labels.set(r.destination.toLowerCase(), r.label);
  for (const e of backend.entries) if (e.label) labels.set(e.destination.toLowerCase(), e.label);
  return labels;
}

export function addressNames(ctx: NamesContext, labels: ReadonlyMap<string, string> = new Map()): NameOf {
  const known = new Map<string, string>();
  const add = (address: string | undefined, name: string) => {
    if (address !== undefined && !known.has(address.toLowerCase())) known.set(address.toLowerCase(), name);
  };
  if (ctx.system) {
    for (const [role, name] of Object.entries(SYSTEM_NAMES) as [SystemRole, string][]) {
      const pinned = ctx.system.contracts[role] as SystemContracts['contracts'][SystemRole] | undefined;
      add(pinned?.address, name);
    }
  }
  add(ctx.chain?.tokens?.usdc.address, 'el contrato de USDC');
  add(ctx.chain?.tokens?.usdt.address, 'el contrato de USDT');
  add(ctx.chain?.uniswap?.pool.address, POOL_NAME);
  add(ctx.safe, 'tu Safe');
  return (address) => known.get(address.toLowerCase()) ?? labels.get(address.toLowerCase()) ?? null;
}
