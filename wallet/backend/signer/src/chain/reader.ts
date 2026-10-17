// Lecturas on-chain del signer (todas con quórum a un bloque común): estado de la Safe (nonce, roles del Guard,
// configuración completa para el paso 7b de [B-Q-02]), saldos y allowance, whitelist, autorización de migración,
// propuestas del timelock, sucesores del Guard y el pre-check `evaluateAssisted` [C-GRD-02].
import { decodeFunctionResult, encodeFunctionData, type Abi } from 'viem';
import type { Hex } from '../crypto/bytes.ts';
import { checksumAddress, keccakHex, sameAddress, type Address } from '../crypto/keccak.ts';
import { utf8 } from '../crypto/bytes.ts';
import {
  destinationWhitelistAbi,
  iSafeAbi,
  policyRegistryAbi,
  rotationTimelockAbi,
  securityGuardAbi,
  walletFactoryAbi,
} from './abis/index.ts';
import type { SignerRpc } from './rpc.ts';

/** Slots de Safe 1.5.0 (keccak de los identificadores de GuardManager, ModuleManager y FallbackManager). */
export const SAFE_SLOTS = {
  guard: keccakHex(utf8('guard_manager.guard.address')),
  moduleGuard: keccakHex(utf8('module_manager.module_guard.address')),
  fallbackHandler: keccakHex(utf8('fallback_manager.handler.address')),
} as const;

const SENTINEL = '0x0000000000000000000000000000000000000001' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

export interface Roles {
  userKey: Address;
  recoveryKey: Address;
  executor: Address;
  initialized: boolean;
}

export interface SafeState {
  block: bigint;
  /** Timestamp del bloque leído (segundos). */
  timestamp: number;
  registered: boolean;
  isWallet: boolean;
  roles: Roles;
  nonce: bigint;
  threshold: bigint;
  owners: Address[];
  guard: Address;
  moduleGuard: Address;
  fallbackHandler: Address;
  modules: Address[];
}

function slotAddress(word: Hex): Address {
  return checksumAddress(`0x${word.slice(-40)}`);
}

export class OnChainReader {
  readonly rpc: SignerRpc;
  readonly #guard: Address;
  readonly #factory: Address;

  constructor(rpc: SignerRpc, contracts: { securityGuard: Address; walletFactory: Address }) {
    this.rpc = rpc;
    this.#guard = contracts.securityGuard;
    this.#factory = contracts.walletFactory;
  }

  async #read(
    abi: Abi,
    address: Address,
    functionName: string,
    args: readonly unknown[],
    block: bigint,
  ): Promise<unknown> {
    const data = encodeFunctionData({ abi, functionName, args });
    const result = await this.rpc.call({ to: address, data }, block);
    return decodeFunctionResult({ abi, functionName, data: result });
  }

  async block(): Promise<bigint> {
    return this.rpc.snapshotBlock();
  }

  async roles(safe: Address, block: bigint): Promise<Roles> {
    const r = (await this.#read(securityGuardAbi, this.#guard, 'rolesOf', [safe], block)) as {
      userKey: Address;
      recoveryKey: Address;
      executor: Address;
      initialized: boolean;
    };
    return {
      userKey: checksumAddress(r.userKey),
      recoveryKey: checksumAddress(r.recoveryKey),
      executor: checksumAddress(r.executor),
      initialized: r.initialized,
    };
  }

  /** Estado completo de la Safe a un bloque común. */
  async safeState(safe: Address, block: bigint): Promise<SafeState> {
    const [
      registered,
      isWallet,
      roles,
      nonce,
      threshold,
      owners,
      guardWord,
      moduleGuardWord,
      fallbackWord,
      modules,
      timestamp,
    ] = await Promise.all([
      this.#read(securityGuardAbi, this.#guard, 'isRegistered', [safe], block) as Promise<boolean>,
      this.#read(walletFactoryAbi, this.#factory, 'isWallet', [safe], block) as Promise<boolean>,
      this.roles(safe, block),
      this.#read(iSafeAbi, safe, 'nonce', [], block) as Promise<bigint>,
      this.#read(iSafeAbi, safe, 'getThreshold', [], block) as Promise<bigint>,
      this.#read(iSafeAbi, safe, 'getOwners', [], block) as Promise<readonly Address[]>,
      this.rpc.storageAt(safe, SAFE_SLOTS.guard, block),
      this.rpc.storageAt(safe, SAFE_SLOTS.moduleGuard, block),
      this.rpc.storageAt(safe, SAFE_SLOTS.fallbackHandler, block),
      this.#read(iSafeAbi, safe, 'getModulesPaginated', [SENTINEL, 10n], block) as Promise<
        readonly [readonly Address[], Address]
      >,
      this.rpc.blockTimestamp(block),
    ]);
    return {
      block,
      timestamp,
      registered,
      isWallet,
      roles,
      nonce,
      threshold,
      owners: owners.map((o) => checksumAddress(o)),
      guard: slotAddress(guardWord),
      moduleGuard: slotAddress(moduleGuardWord),
      fallbackHandler: slotAddress(fallbackWord),
      modules: modules[0].map((m) => checksumAddress(m)),
    };
  }

  async tokenBalance(token: Address, owner: Address, block: bigint): Promise<bigint> {
    return (await this.#read(erc20Abi, token, 'balanceOf', [owner], block)) as bigint;
  }

  async allowance(token: Address, owner: Address, spender: Address, block: bigint): Promise<bigint> {
    return (await this.#read(erc20Abi, token, 'allowance', [owner, spender], block)) as bigint;
  }

  async isWhitelisted(whitelist: Address, safe: Address, destination: Address, block: bigint): Promise<boolean> {
    return (await this.#read(
      destinationWhitelistAbi,
      whitelist,
      'isWhitelisted',
      [safe, destination],
      block,
    )) as boolean;
  }

  async isMigrationAuthorized(registry: Address, safe: Address, destination: Address, block: bigint): Promise<boolean> {
    return (await this.#read(
      policyRegistryAbi,
      registry,
      'isMigrationAuthorized',
      [safe, destination],
      block,
    )) as boolean;
  }

  async successorOf(
    registry: Address,
    kind: 'GUARD' | 'MODULE_GUARD',
    current: Address,
    block: bigint,
  ): Promise<Address> {
    const fn = kind === 'GUARD' ? 'successorGuardOf' : 'successorModuleGuardOf';
    return checksumAddress((await this.#read(policyRegistryAbi, registry, fn, [current], block)) as Address);
  }

  /** Id de la propuesta PENDING y madura para (safe, kind, old, new), o null. kind: enum RotationKind (0..4). */
  async executableProposal(
    timelock: Address,
    safe: Address,
    kind: number,
    oldValue: Address,
    newValue: Address,
    block: bigint,
  ): Promise<Hex | null> {
    const id = (await this.#read(
      rotationTimelockAbi,
      timelock,
      'executableProposal',
      [safe, kind, oldValue, newValue],
      block,
    )) as Hex;
    return /^0x0{64}$/.test(id) ? null : id;
  }

  /** Pre-check sin efectos del Guard [C-GRD-02]: role según el enum Role (1 = U, 2 = R). */
  async evaluateAssisted(
    safe: Address,
    role: number,
    to: Address,
    value: bigint,
    data: Hex,
    block: bigint,
  ): Promise<{ ok: boolean; reason: Hex }> {
    const [ok, reason] = (await this.#read(
      securityGuardAbi,
      this.#guard,
      'evaluateAssisted',
      [safe, role, to, value, data],
      block,
    )) as [boolean, Hex];
    return { ok, reason };
  }
}

export interface SafeConfigProblem {
  field: 'registered' | 'guard' | 'moduleGuard' | 'fallbackHandler' | 'modules' | 'threshold' | 'owners';
}

/**
 * Paso 7b de [B-Q-02]: la configuración on-chain de la Safe sigue intacta (Guard, module guard, fallback 0, sin
 * módulos, threshold 2, owners == roles). Devuelve los campos que difieren (vacío = intacta).
 */
export function safeConfigProblems(
  state: SafeState,
  contracts: { securityGuard: Address; denyAllModuleGuard: Address },
): SafeConfigProblem['field'][] {
  const problems: SafeConfigProblem['field'][] = [];
  if (!state.registered || !state.roles.initialized) problems.push('registered');
  if (!sameAddress(state.guard, contracts.securityGuard)) problems.push('guard');
  if (!sameAddress(state.moduleGuard, contracts.denyAllModuleGuard)) problems.push('moduleGuard');
  if (!sameAddress(state.fallbackHandler, ZERO)) problems.push('fallbackHandler');
  if (state.modules.length > 0) problems.push('modules');
  if (state.threshold !== 2n) problems.push('threshold');
  const roles = [state.roles.userKey, state.roles.recoveryKey, state.roles.executor].map((a) => a.toLowerCase()).sort();
  const owners = state.owners.map((a) => a.toLowerCase()).sort();
  if (owners.length !== 3 || owners.some((o, i) => o !== roles[i])) problems.push('owners');
  return problems;
}
