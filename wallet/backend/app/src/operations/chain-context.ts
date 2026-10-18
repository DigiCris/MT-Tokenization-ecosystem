// Contexto on-chain de una operación (P13): estado de la Safe (paso 4, 5 y 7b de [B-Q-02]), hechos de la policy que
// dependen de la cadena (paso 6 y 7: saldos, allowance, whitelist, migración, propuestas del timelock, sucesores del
// Guard) y, si se pide, el pre-check sin efectos del paso 8: `SecurityGuard.evaluateAssisted` y `eth_call` de la llamada
// interna desde la Safe al target. Todo en UN bloque y con quórum: los dos proveedores tienen que devolver exactamente
// el mismo contexto o no se decide nada ([B-RPC-02]).
import { decodeErrorResult, getAddress, isAddressEqual, type Abi, type Address, type Hex } from 'viem';
import {
  destinationWhitelistAbi,
  policyRegistryAbi,
  rotationTimelockAbi,
  securityGuardAbi,
  swapExecutorV3Abi,
} from '../chain/abis/index.ts';
import { Role, RotationKind } from '../chain/constants.ts';
import type { DecodedCall } from '../chain/decoders/safe-call.ts';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import { readSafeState, type SafeChainState } from '../chain/safe-state.ts';
import type { SafeTx } from '../chain/safe-tx.ts';
import type { PolicyFacts } from '../policy/evaluate.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';

const ZERO_ID = /^0x0{64}$/;

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

/** Hechos on-chain de la policy, serializables (bigint como string) para comparar los dos proveedores. */
export interface ChainFacts {
  balance?: string;
  allowance?: string;
  destinationWhitelisted?: boolean;
  migrationAuthorized?: boolean;
  rotationExecutable?: boolean;
  prevOwnerCorrect?: boolean;
  successorRegistered?: boolean;
  guardUpgradeMature?: boolean;
}

export interface Precheck {
  /** evaluateAssisted [C-GRD-02]: ok y motivo (selector del error del Guard). */
  guardOk: boolean;
  guardReason: Hex;
  /** eth_call desde la Safe al target. */
  callOk: boolean;
  callRevert: Hex | null;
}

export interface OperationChainContext {
  state: SafeChainState;
  facts: ChainFacts;
  precheck: Precheck | null;
}

export interface ContextRequest {
  safe: Address;
  safeTx: SafeTx;
  call: DecodedCall;
  ownerRole: 'U' | 'R';
  precheck: boolean;
}

function revertData(error: unknown): Hex | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    const data = (current as { data?: unknown }).data;
    if (typeof data === 'string' && data.startsWith('0x')) return data as Hex;
    if (data && typeof (data as { data?: unknown }).data === 'string') return (data as { data: Hex }).data;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Revert de ejecución (la llamada llegó al nodo y revirtió), a diferencia de una falla del RPC. */
function isExecutionRevert(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    const name = (current as { name?: unknown }).name;
    if (
      name === 'ExecutionRevertedError' ||
      name === 'ContractFunctionRevertedError' ||
      name === 'CallExecutionError'
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function readOperationContext(
  rpc: RpcQuorumClient,
  snapshot: BackendPolicySnapshot,
  request: ContextRequest,
): Promise<{ value: OperationChainContext; blockNumber: bigint }> {
  const c = snapshot.contracts;
  const { safe, safeTx, call } = request;
  return rpc.readSensitive('operation-context', async (client, blockNumber) => {
    const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
      client.readContract({ address, abi, functionName, args, blockNumber }) as Promise<T>;
    const state = await readSafeState(client, blockNumber, snapshot, safe);
    const facts: ChainFacts = {};
    switch (call.kind) {
      case 'ERC20_TRANSFER': {
        const [balance, whitelisted, migration] = await Promise.all([
          read<bigint>(call.tokenAddress, erc20Abi, 'balanceOf', [safe]),
          read<boolean>(c.destinationWhitelist, destinationWhitelistAbi, 'isWhitelisted', [safe, call.recipient]),
          read<boolean>(c.policyRegistry, policyRegistryAbi, 'isMigrationAuthorized', [safe, call.recipient]),
        ]);
        facts.balance = balance.toString();
        facts.destinationWhitelisted = whitelisted;
        facts.migrationAuthorized = migration;
        break;
      }
      case 'ERC20_APPROVE':
        facts.balance = (await read<bigint>(call.tokenAddress, erc20Abi, 'balanceOf', [safe])).toString();
        break;
      case 'SWAP': {
        const [balance, allowance] = await Promise.all([
          read<bigint>(call.tokenInAddress, erc20Abi, 'balanceOf', [safe]),
          read<bigint>(call.tokenInAddress, erc20Abi, 'allowance', [safe, c.swapExecutor]),
        ]);
        facts.balance = balance.toString();
        facts.allowance = allowance.toString();
        break;
      }
      case 'ROTATION_PROPOSE':
        if (call.rotationKind === RotationKind.Guard || call.rotationKind === RotationKind.ModuleGuard) {
          const fn = call.rotationKind === RotationKind.Guard ? 'successorGuardOf' : 'successorModuleGuardOf';
          const successor = await read<Address>(c.policyRegistry, policyRegistryAbi, fn, [call.oldValue]);
          facts.successorRegistered = isAddressEqual(successor, call.newValue);
        }
        break;
      case 'SWAP_OWNER': {
        const index = state.owners.findIndex((o) => isAddressEqual(o, call.oldOwner));
        const expectedPrev =
          index <= 0 ? getAddress('0x0000000000000000000000000000000000000001') : state.owners[index - 1];
        facts.prevOwnerCorrect =
          index >= 0 && expectedPrev !== undefined && isAddressEqual(expectedPrev, call.prevOwner);
        const roles = state.roles;
        const kind = isAddressEqual(call.oldOwner, roles.userKey)
          ? RotationKind.User
          : isAddressEqual(call.oldOwner, roles.recoveryKey)
            ? RotationKind.Recovery
            : isAddressEqual(call.oldOwner, roles.executor)
              ? RotationKind.Executor
              : undefined;
        if (kind !== undefined) {
          const id = await read<Hex>(state.timelock, rotationTimelockAbi, 'executableProposal', [
            safe,
            kind,
            call.oldOwner,
            call.newOwner,
          ]);
          facts.rotationExecutable = !ZERO_ID.test(id);
        } else {
          facts.rotationExecutable = false;
        }
        break;
      }
      case 'SET_GUARD':
      case 'SET_MODULE_GUARD': {
        const isGuard = call.kind === 'SET_GUARD';
        const current = isGuard ? state.guard : state.moduleGuard;
        const newValue = call.kind === 'SET_GUARD' ? call.guard : call.moduleGuard;
        const [successor, id] = await Promise.all([
          read<Address>(c.policyRegistry, policyRegistryAbi, isGuard ? 'successorGuardOf' : 'successorModuleGuardOf', [
            current,
          ]),
          read<Hex>(state.timelock, rotationTimelockAbi, 'executableProposal', [
            safe,
            isGuard ? RotationKind.Guard : RotationKind.ModuleGuard,
            current,
            newValue,
          ]),
        ]);
        facts.successorRegistered = isAddressEqual(successor, newValue);
        facts.guardUpgradeMature = !ZERO_ID.test(id);
        break;
      }
      case 'NOOP':
      case 'WHITELIST_ADD':
      case 'WHITELIST_REMOVE':
      case 'ROTATION_CANCEL':
        break;
    }
    let precheck: Precheck | null = null;
    if (request.precheck) {
      const [ok, reason] = await read<readonly [boolean, Hex]>(
        state.governingGuard,
        securityGuardAbi,
        'evaluateAssisted',
        [safe, request.ownerRole === 'U' ? Role.User : Role.Recovery, safeTx.to, safeTx.value, safeTx.data],
      );
      let callOk = true;
      let callRevert: Hex | null = null;
      try {
        await client.call({ account: safe, to: safeTx.to, data: safeTx.data, value: safeTx.value, blockNumber });
      } catch (error) {
        if (!isExecutionRevert(error)) throw error;
        callOk = false;
        callRevert = revertData(error) ?? '0x';
      }
      precheck = { guardOk: ok, guardReason: reason, callOk, callRevert };
    }
    return { state, facts, precheck };
  });
}

/** Hechos on-chain → PolicyFacts (los de la DB y los de atestaciones los completa quien llama). */
export function policyFactsFrom(context: OperationChainContext): PolicyFacts {
  const { state, facts } = context;
  return {
    now: state.timestamp,
    roles: { userKey: state.roles.userKey, recoveryKey: state.roles.recoveryKey, executor: state.roles.executor },
    dailyOutflowUsed: 0n,
    ...(facts.balance === undefined ? {} : { balance: BigInt(facts.balance) }),
    ...(facts.allowance === undefined ? {} : { allowance: BigInt(facts.allowance) }),
    ...(facts.destinationWhitelisted === undefined ? {} : { destinationWhitelisted: facts.destinationWhitelisted }),
    ...(facts.migrationAuthorized === undefined ? {} : { migrationAuthorized: facts.migrationAuthorized }),
    ...(facts.rotationExecutable === undefined ? {} : { rotationExecutable: facts.rotationExecutable }),
    ...(facts.prevOwnerCorrect === undefined ? {} : { prevOwnerCorrect: facts.prevOwnerCorrect }),
    ...(facts.successorRegistered === undefined ? {} : { successorRegistered: facts.successorRegistered }),
    ...(facts.guardUpgradeMature === undefined ? {} : { guardUpgradeMature: facts.guardUpgradeMature }),
    currentGuard: state.guard,
    currentModuleGuard: state.moduleGuard,
    safeTimelock: state.timelock,
  };
}

/** Nombre del error custom del Guard/SwapExecutor (o Error(string) de Safe, p. ej. GS013) a partir del revert. */
export function decodeRevertReason(data: Hex | null): string {
  if (data === null || data === '0x') return 'UNKNOWN';
  for (const abi of [securityGuardAbi, swapExecutorV3Abi] as Abi[]) {
    try {
      const decoded = decodeErrorResult({ abi, data });
      if (decoded.errorName === 'Error' && typeof decoded.args?.[0] === 'string') return decoded.args[0];
      return decoded.errorName;
    } catch {
      // probar con el siguiente ABI
    }
  }
  return data.slice(0, 10);
}
