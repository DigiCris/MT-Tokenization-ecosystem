// P18.SEC: la SafeTx que arma la app reproduce el vector cruzado de contracts/ (test/vectors/safe-tx.json, las 12
// operaciones del camino asistido con su hash y la firma de U), los decodificadores reconocen cada una desde los bytes
// con las direcciones fijadas, y una operación preparada que difiere en cualquier campo de la armada localmente no se
// firma.
import { encodeFunctionData, keccak256, toBytes, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import safeTxVectors from '../../test/vectors/safe-tx.json';
import systemVector from '../../test/vectors/system.json';
import type { PreparedOperation, SafeTxJson } from '../api/wallet-api.ts';
import { pinnedChain } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';
import { fromHex } from '../crypto/bytes.ts';
import { signDigest } from '../crypto/sign.ts';
import { iSafeAbi } from './abis/ISafe.ts';
import { rotationTimelockAbi } from './abis/RotationTimelock.ts';
import { securityGuardAbi } from './abis/SecurityGuard.ts';
import { swapExecutorV3Abi } from './abis/SwapExecutorV3.ts';
import { decodeSafeTx, type DecodedCall } from './decoders.ts';
import { assistedCall, parseSafeTx, safeTxHash, SafeTxMismatchError, verifyPrepared } from './safe-tx.ts';

interface VectorOperation extends Omit<SafeTxJson, 'nonce'> {
  opType: string;
  nonce: number;
  safeTxHash: Hex;
  signatureUser: Hex;
}

const vectors = safeTxVectors as unknown as { safe: Address; chainId: number; operations: VectorOperation[] };
const system = systemVector as unknown as {
  keys: Record<'user' | 'recovery' | 'executor', { label: string; address: Address }>;
  contracts: Record<string, Address>;
  codehashes: Record<string, Hex>;
};
const userKey = toBytes(keccak256(toBytes(system.keys.user.label)));
const contract = (name: string) => ({ name, address: system.contracts[name] ?? '0x', codehash: '0x' as const });
const ctx = {
  safe: vectors.safe,
  chain: pinnedChain,
  system: {
    contracts: {
      guard: contract('securityGuard'),
      timelock: contract('rotationTimelock'),
      policyRegistry: contract('policyRegistry'),
      whitelist: contract('destinationWhitelist'),
      swapExecutor: contract('swapExecutor'),
      bootstrap: contract('safeBootstrap'),
      factory: contract('walletFactory'),
      moduleGuard: contract('denyAllModuleGuard'),
    },
  } as unknown as Pick<SystemContracts, 'contracts'>,
};
const json = (op: VectorOperation): SafeTxJson => ({ ...op, nonce: String(op.nonce) });

const EXPECTED_KIND: Record<string, DecodedCall['kind']> = {
  NOOP: 'NOOP',
  TRANSFER: 'TRANSFER',
  APPROVE: 'APPROVE',
  APPROVE_REVOKE: 'APPROVE',
  SWAP: 'SWAP',
  WHITELIST_ADD: 'WHITELIST_ADD',
  WHITELIST_REMOVE: 'WHITELIST_REMOVE',
  ROTATION_PROPOSE: 'ROTATION_PROPOSE',
  ROTATION_CANCEL: 'ROTATION_CANCEL',
  ROTATION_EXECUTE: 'ROTATION_EXECUTE',
  MIGRATION_TRANSFER: 'TRANSFER',
  GUARD_UPGRADE: 'GUARD_UPGRADE',
};

describe('SafeTx propia (vector de contracts/)', () => {
  it.each(vectors.operations.map((op) => [op.opType, op] as const))(
    '%s: hash, firma de U y decodificación',
    (opType, op) => {
      const tx = parseSafeTx(json(op));
      const hash = safeTxHash(vectors.chainId, vectors.safe, tx);
      expect(hash).toBe(op.safeTxHash);
      expect(signDigest(fromHex(hash), userKey)).toBe(op.signatureUser);
      expect(decodeSafeTx(tx, ctx).kind).toBe(EXPECTED_KIND[opType]);
    },
  );

  it('decodifica los campos: transfer, swap y propuesta de rotación de S', () => {
    const byType = (t: string) => {
      const op = vectors.operations.find((o) => o.opType === t);
      if (!op) throw new Error(t);
      return decodeSafeTx(parseSafeTx(json(op)), ctx);
    };
    expect(byType('TRANSFER')).toMatchObject({ kind: 'TRANSFER', token: 'USDC' });
    expect(byType('SWAP')).toMatchObject({ kind: 'SWAP', tokenIn: 'USDC', tokenOut: 'USDT' });
    expect(byType('ROTATION_PROPOSE')).toMatchObject({ kind: 'ROTATION_PROPOSE', role: 'S' });
    expect(byType('APPROVE_REVOKE')).toMatchObject({ kind: 'APPROVE', amount: 0n });
  });

  it('cada contrato reconoce sólo sus llamadas del camino asistido', () => {
    const c = ctx.system.contracts;
    const guardRoles = assistedCall(
      c.guard.address,
      encodeFunctionData({
        abi: securityGuardAbi,
        functionName: 'updateRoles',
        args: [system.keys.user.address, system.keys.recovery.address, system.keys.executor.address],
      }),
      1n,
    );
    expect(decodeSafeTx(guardRoles, ctx)).toMatchObject({
      kind: 'GUARD_ROLES_UPDATE',
      executor: system.keys.executor.address,
    });
    const moduleGuard = assistedCall(
      vectors.safe,
      encodeFunctionData({ abi: iSafeAbi, functionName: 'setModuleGuard', args: [system.keys.user.address] }),
      1n,
    );
    expect(decodeSafeTx(moduleGuard, ctx)).toMatchObject({ kind: 'GUARD_UPGRADE', target: 'MODULE_GUARD' });
    for (const to of [
      vectors.safe,
      pinnedChain.tokens.usdc.address,
      c.swapExecutor.address,
      c.whitelist.address,
      c.timelock.address,
      c.guard.address,
    ]) {
      expect(decodeSafeTx(assistedCall(to, '0x12345678', 1n), ctx).kind, to).toBe('UNKNOWN');
    }
    const otherToken = assistedCall(
      c.swapExecutor.address,
      encodeFunctionData({
        abi: swapExecutorV3Abi,
        functionName: 'swap',
        args: [system.keys.user.address, 1n, 1n, 1n],
      }),
      1n,
    );
    expect(decodeSafeTx(otherToken, ctx).kind).toBe('UNKNOWN');
    const badKind = assistedCall(
      c.timelock.address,
      encodeFunctionData({
        abi: rotationTimelockAbi,
        functionName: 'propose',
        args: [9, system.keys.user.address, system.keys.user.address],
      }),
      1n,
    );
    expect(decodeSafeTx(badKind, ctx).kind).toBe('UNKNOWN');
  });

  it('lo que no es del camino asistido queda UNKNOWN', () => {
    const base = assistedCall(ctx.system.contracts.whitelist.address, '0xdeadbeef', 1n);
    expect(decodeSafeTx(base, ctx).kind).toBe('UNKNOWN');
    expect(decodeSafeTx({ ...base, operation: 1 }, ctx)).toEqual({ kind: 'UNKNOWN', reason: 'DELEGATECALL' });
    expect(decodeSafeTx({ ...base, value: 1n }, ctx).kind).toBe('UNKNOWN');
    expect(decodeSafeTx({ ...base, gasPrice: 1n }, ctx).kind).toBe('UNKNOWN');
    expect(decodeSafeTx({ ...base, to: '0x000000000000000000000000000000000000dEaD' }, ctx).kind).toBe('UNKNOWN');
  });
});

describe('operación preparada por el backend vs la armada por la app', () => {
  const op = vectors.operations.find((o) => o.opType === 'TRANSFER');
  if (!op) throw new Error('vector sin TRANSFER');
  const prepared = (
    overrides: Partial<PreparedOperation> = {},
    safeTx: Partial<SafeTxJson> = {},
  ): PreparedOperation => ({
    operationId: '11111111-1111-4111-8111-111111111111',
    groupId: null,
    walletId: '22222222-2222-4222-8222-222222222222',
    safe: vectors.safe,
    chainId: 8453,
    operationType: 'SEND',
    safeTx: { ...json(op), ...safeTx },
    safeTxHash: op.safeTxHash,
    typedData: {},
    decoded: {},
    requiresTwoFactor: false,
    expiresAt: '2026-10-18T12:00:00Z',
    ...overrides,
  });
  const expected = {
    safe: vectors.safe,
    chainId: 8453,
    build: (nonce: bigint) => assistedCall(op.to, op.data, nonce),
    onchainNonce: 1n,
  };
  const fieldsOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      if (error instanceof SafeTxMismatchError) return error.fields;
      throw error;
    }
    return [];
  };

  it('igual campo por campo: devuelve el hash local para firmar', () => {
    expect(verifyPrepared(prepared(), expected).hash).toBe(op.safeTxHash);
  });

  it.each<[string, () => PreparedOperation, string[]]>([
    ['otros datos (otro destino del transfer)', () => prepared({}, { data: `0x${op.data.slice(2, -2)}00` }), ['data']],
    ['otro contrato', () => prepared({}, { to: system.contracts.usdt ?? '0x' }), ['to']],
    ['reembolso de gas', () => prepared({}, { gasPrice: '1' }), ['gasPrice']],
    ['otra Safe', () => prepared({ safe: system.keys.recovery.address }), ['safe']],
    ['otra cadena', () => prepared({ chainId: 1 }), ['chainId']],
    ['hash que no es el de la SafeTx', () => prepared({ safeTxHash: `0x${'00'.repeat(32)}` }), ['safeTxHash']],
    ['nonce ya usado on-chain', () => prepared({}, { nonce: '0' }), ['nonce', 'safeTxHash']],
    ['nonce demasiado adelante', () => prepared({}, { nonce: '99' }), ['nonce', 'safeTxHash']],
    ['uint256 mal formado', () => prepared({}, { value: '01' }), ['value']],
  ])('no firma con %s', (_label, make, fields) => {
    expect(fieldsOf(() => verifyPrepared(make(), expected))).toEqual(fields);
  });
});
