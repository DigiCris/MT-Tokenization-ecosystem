// Nombres que la app conoce por dirección para el review y la actividad (P18.MAN): los contratos del sistema y los
// tokens fijados en el build, el pool de Uniswap que usa la app, la propia Safe y los labels de la whitelist (texto del
// usuario que vienen del backend). Un label nunca tapa a un contrato del sistema, y la dirección completa se muestra
// siempre al lado del nombre: el nombre ayuda a reconocerla, no la reemplaza. Un label se muestra entre «» y no puede
// imitar un nombre de la app («tu Safe», «el contrato de swap de la plataforma»…), ni una dirección.
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

export const POOL_NAME = 'el pool USDC/USDT de Uniswap que usa la app';
export const SAFE_NAME = 'tu Safe';
const TOKEN_NAMES = { usdc: 'el contrato de USDC', usdt: 'el contrato de USDT' } as const;

/** Todos los nombres con los que la app presenta sus propias direcciones. */
export const RESERVED_NAMES: readonly string[] = [
  ...Object.values(SYSTEM_NAMES),
  ...Object.values(TOKEN_NAMES),
  POOL_NAME,
  SAFE_NAME,
];

/** Un label de la whitelist tal como se muestra: entre «», para que no se lea como un nombre de la app. */
export function userLabel(label: string): string {
  return `«${label}»`;
}

/** Para comparar nombres: sin tildes, mayúsculas, signos ni aclaraciones entre paréntesis, y sin el artículo inicial. */
function nameKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(el|la|los|las|tu|tus|mi|mis|su|sus|nuestra|nuestro) /, '');
}

const RESERVED_KEYS = new Set(RESERVED_NAMES.map(nameKey));

/**
 * Por qué no se puede usar un label (null si se puede): vacío, con « o » (la app los usa para marcar los labels), con
 * algo que parece una dirección, o igual a un nombre de la app.
 */
export function labelProblem(label: string): string | null {
  const value = label.trim();
  if (value === '') return 'Escribí un nombre para reconocer el destino.';
  if (/[«»]/.test(value))
    return 'El nombre no puede tener « ni »: la app los usa para marcar los nombres que escribís vos.';
  if (/0x\s*[0-9a-f]{4}/i.test(value)) {
    return 'El nombre no puede incluir una dirección (0x…): la dirección completa ya se muestra al lado.';
  }
  if (RESERVED_KEYS.has(nameKey(value))) {
    return `«${value}» es un nombre que la app usa para sus propias direcciones (como «${SAFE_NAME}»): elegí otro.`;
  }
  return null;
}

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

/** Los labels como se muestran en pantalla, entre «» (userLabel): para pasarle a addressNames. */
export function shownLabels(labels: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...labels].map(([address, label]) => [address, userLabel(label)]));
}

/** El nombre de cada dirección: los de la app y, si no es una de ellas, el label (las pantallas, con shownLabels). */
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
  add(ctx.chain?.tokens?.usdc.address, TOKEN_NAMES.usdc);
  add(ctx.chain?.tokens?.usdt.address, TOKEN_NAMES.usdt);
  add(ctx.chain?.uniswap?.pool.address, POOL_NAME);
  add(ctx.safe, SAFE_NAME);
  return (address) => known.get(address.toLowerCase()) ?? labels.get(address.toLowerCase()) ?? null;
}
