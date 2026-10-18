// [F-SEC-08]/[F-KEY-10]: la U vigente se lee on-chain con los contratos fijados: el Guard instalado en la Safe (slot de
// Safe v1.5) tiene que ser el SecurityGuard del build, la Safe una wallet registrada de la WalletFactory y el RPC de
// Base. Contra el fork real lo prueba test/browser/stack/restore.spec.ts.
import { describe, expect, it } from 'vitest';
import type { SystemContracts } from '../config/system-contracts.ts';
import { frontendClient, onchainRoles, OnchainCheckError, SAFE_GUARD_SLOT, type BaseClient } from './roles.ts';

const GUARD = '0x1111111111111111111111111111111111111111';
const FACTORY = '0x2222222222222222222222222222222222222222';
const SAFE = '0x3333333333333333333333333333333333333333';
const contracts = {
  guard: { name: 'SecurityGuard', address: GUARD, codehash: `0x${'0'.repeat(64)}` },
  factory: { name: 'WalletFactory', address: FACTORY, codehash: `0x${'0'.repeat(64)}` },
} as unknown as SystemContracts['contracts'];

function reader(options: { chainId?: number; guard?: string; isWallet?: boolean; initialized?: boolean } = {}) {
  const calls: unknown[] = [];
  const client = {
    getChainId: () => Promise.resolve(options.chainId ?? 8453),
    getStorageAt: (args: { address: string; slot: string }) => {
      calls.push(args);
      return Promise.resolve(`0x${'0'.repeat(24)}${(options.guard ?? GUARD).slice(2)}` as `0x${string}`);
    },
    readContract: (args: { functionName: string; address: string }) => {
      calls.push(args);
      if (args.functionName === 'isWallet') return Promise.resolve(options.isWallet ?? true);
      return Promise.resolve({
        userKey: '0x79406eb1d6abda075a9789dbd7d31626fefe2904',
        recoveryKey: '0x7184d30100a188c9f869ccb6883392534ecd6c9d',
        executor: '0xc80d387fcc59cb57aef0ec2b137c77d26474288e',
        initialized: options.initialized ?? true,
      });
    },
  } as unknown as Pick<BaseClient, 'getStorageAt' | 'readContract' | 'getChainId'>;
  return { client, calls };
}

describe('roles on-chain', () => {
  it('lee los roles del Guard fijado instalado en la Safe (direcciones con checksum)', async () => {
    const { client, calls } = reader();
    expect(await onchainRoles(client, contracts, SAFE)).toEqual({
      userKey: '0x79406Eb1d6abdA075A9789DBD7d31626FEFE2904',
      recoveryKey: '0x7184D30100a188c9F869ccB6883392534ecD6C9d',
      executor: '0xc80D387fCc59cB57AEf0eC2b137C77D26474288E',
    });
    expect(calls[0]).toEqual({ address: SAFE, slot: SAFE_GUARD_SLOT });
    expect(calls).toContainEqual(expect.objectContaining({ functionName: 'rolesOf', address: GUARD }));
    expect(calls).toContainEqual(expect.objectContaining({ functionName: 'isWallet', address: FACTORY }));
  });

  it.each([
    ['otra cadena', { chainId: 1 }, 'no es de Base'],
    ['otro Guard instalado', { guard: '0x4444444444444444444444444444444444444444' }, 'Guard del sistema'],
    ['Safe que no es una wallet', { isWallet: false }, 'wallet registrada'],
    ['roles sin inicializar', { initialized: false }, 'wallet registrada'],
  ])('%s: no se confía', async (_label, options, message) => {
    await expect(onchainRoles(reader(options).client, contracts, SAFE)).rejects.toThrow(OnchainCheckError);
    await expect(onchainRoles(reader(options).client, contracts, SAFE)).rejects.toThrow(message);
  });

  it('un solo cliente de lectura de Base por pestaña, con el RPC del frontend', () => {
    const client = frontendClient('http://127.0.0.1:8545');
    expect(client.chain.id).toBe(8453);
    expect(frontendClient('http://127.0.0.1:8545')).toBe(client);
  });
});
