// Gobernanza en el fork para los tests de P15 (migración excepcional y upgrade del Guard): la Governance Safe (admin del
// PolicyRegistry) y los guardianes del deploy de prueba actúan por impersonación de Anvil — las propuestas, el timelock
// de 24 h, la activación y la cancelación son las reales del PolicyRegistry; la mecánica multisig de la Governance Safe
// la cubren los tests de contratos (P04/P05).
import { decodeEventLog, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { policyRegistryAbi } from '../../src/chain/abis/index.ts';
import type { OperationsEnv } from './operations.ts';

/** 24 h del timelock del PolicyRegistry más un segundo. */
export const REGISTRY_DELAY_SECONDS = 24 * 3600 + 1;

export class Governance {
  readonly #env: OperationsEnv;

  constructor(env: OperationsEnv) {
    this.#env = env;
  }

  get admin(): Address {
    return getAddress(this.#env.base.system.policy.admin);
  }

  get guardian(): Address {
    const first = this.#env.base.system.policy.guardians[0];
    if (first === undefined) throw new Error('el deploy de prueba no tiene guardianes');
    return getAddress(first);
  }

  /** Transacción al PolicyRegistry desde `from` (impersonado); devuelve el receipt. */
  async #send(from: Address, data: Hex) {
    const chain = this.#env.chain;
    await chain.setBalance(from, 10n ** 18n);
    await chain.rpc('anvil_impersonateAccount', [from]);
    try {
      const hash = await chain.rpc<Hex>('eth_sendTransaction', [
        { from, to: this.#env.base.snapshot.contracts.policyRegistry, data, gas: '0x7a1200' },
      ]);
      return await chain.public.waitForTransactionReceipt({ hash });
    } finally {
      await chain.rpc('anvil_stopImpersonatingAccount', [from]);
    }
  }

  /** Propuesta del admin (24 h): devuelve el id del cambio del evento ChangeProposed. */
  async #propose(data: Hex): Promise<Hex> {
    const receipt = await this.#send(this.admin, data);
    if (receipt.status !== 'success') throw new Error('la propuesta del admin revirtió');
    for (const log of receipt.logs) {
      try {
        const event = decodeEventLog({ abi: policyRegistryAbi, data: log.data, topics: log.topics });
        if (event.eventName === 'ChangeProposed') return event.args.id;
      } catch {
        // otro evento
      }
    }
    throw new Error('la propuesta no emitió ChangeProposed');
  }

  proposeMigration(oldSafe: Address, newSafe: Address): Promise<Hex> {
    return this.#propose(
      encodeFunctionData({
        abi: policyRegistryAbi,
        functionName: 'proposeMigrationAuthorization',
        args: [oldSafe, newSafe],
      }),
    );
  }

  proposeSuccessorGuard(guard: Address, successor: Address): Promise<Hex> {
    return this.#propose(
      encodeFunctionData({ abi: policyRegistryAbi, functionName: 'proposeSuccessorGuard', args: [guard, successor] }),
    );
  }

  proposeSuccessorModuleGuard(moduleGuard: Address, successor: Address): Promise<Hex> {
    return this.#propose(
      encodeFunctionData({
        abi: policyRegistryAbi,
        functionName: 'proposeSuccessorModuleGuard',
        args: [moduleGuard, successor],
      }),
    );
  }

  /** `activateChange` es pública (cualquiera la llama cuando el cambio maduró). */
  async activate(id: Hex): Promise<'success' | 'reverted'> {
    const receipt = await this.#send(
      this.#env.chain.relayer.address,
      encodeFunctionData({
        abi: policyRegistryAbi,
        functionName: 'activateChange',
        args: [id],
      }),
    );
    return receipt.status;
  }

  async cancelAsGuardian(id: Hex): Promise<'success' | 'reverted'> {
    const receipt = await this.#send(
      this.guardian,
      encodeFunctionData({ abi: policyRegistryAbi, functionName: 'cancelChange', args: [id] }),
    );
    return receipt.status;
  }

  async isMigrationAuthorized(oldSafe: Address, newSafe: Address): Promise<boolean> {
    return this.#env.chain.public.readContract({
      address: this.#env.base.snapshot.contracts.policyRegistry,
      abi: policyRegistryAbi,
      functionName: 'isMigrationAuthorized',
      args: [oldSafe, newSafe],
    });
  }
}
