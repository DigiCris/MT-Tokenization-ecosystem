// P08.T06: codificación SafeTx/EIP-712, decoders, firmas, typed data de plataforma, CancelRotation y CREATE2 del
// backend contra los vectores que genera Foundry (copia en test/vectors, verificada contra la fuente).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAddress, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { SystemAddresses } from '../../src/chain/constants.ts';
import { predictSafeAddress, safeInitializer, safeSalt } from '../../src/chain/create2.ts';
import { decodeSafeCall, type DecodedCall } from '../../src/chain/decoders/index.ts';
import {
  cancelRotationDigest,
  domainSeparator,
  platformDigest,
  platformDomain,
  platformStructHash,
  typeHash,
  type PlatformMessages,
  type PlatformPrimaryType,
} from '../../src/chain/eip712.ts';
import {
  isPlainCall,
  SAFE_DOMAIN_TYPEHASH,
  SAFE_TX_TYPEHASH,
  safeDomainSeparator,
  safeTxHash,
  type SafeTx,
} from '../../src/chain/safe-tx.ts';
import { recoverStrictSigner, splitSignatures } from '../../src/chain/signatures.ts';

const VECTORS = resolve(import.meta.dirname, '../vectors');
const load = (name: string): unknown => JSON.parse(readFileSync(resolve(VECTORS, name), 'utf8'));

interface SafeTxVector {
  opType: string;
  to: Address;
  value: string;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: Address;
  refundReceiver: Address;
  nonce: number;
  safeTxHash: Hex;
  signatureUser: Hex;
  signatureExecutor: Hex;
  signaturesUserExecutor: Hex;
  signatureRecovery: Hex;
}

const safeTxVectors = load('safe-tx.json') as {
  safe: Address;
  chainId: number;
  domainTypehash: Hex;
  safeTxTypehash: Hex;
  domainSeparator: Hex;
  operations: SafeTxVector[];
};
const system = load('system.json') as {
  chainId: number;
  keys: Record<'user' | 'recovery' | 'executor', { address: Address }>;
  contracts: SystemAddresses;
  safe: Address;
};

function toSafeTx(v: SafeTxVector): SafeTx {
  return {
    to: v.to,
    value: BigInt(v.value),
    data: v.data,
    operation: v.operation,
    safeTxGas: BigInt(v.safeTxGas),
    baseGas: BigInt(v.baseGas),
    gasPrice: BigInt(v.gasPrice),
    gasToken: v.gasToken,
    refundReceiver: v.refundReceiver,
    nonce: BigInt(v.nonce),
  };
}

const EXPECTED_KIND: Record<string, DecodedCall['kind']> = {
  NOOP: 'NOOP',
  TRANSFER: 'ERC20_TRANSFER',
  APPROVE: 'ERC20_APPROVE',
  APPROVE_REVOKE: 'ERC20_APPROVE',
  SWAP: 'SWAP',
  WHITELIST_ADD: 'WHITELIST_ADD',
  WHITELIST_REMOVE: 'WHITELIST_REMOVE',
  ROTATION_PROPOSE: 'ROTATION_PROPOSE',
  ROTATION_CANCEL: 'ROTATION_CANCEL',
  ROTATION_EXECUTE: 'SWAP_OWNER',
  MIGRATION_TRANSFER: 'ERC20_TRANSFER',
  GUARD_UPGRADE: 'SET_GUARD',
};

describe('SafeTx EIP-712 (Safe v1.5.0)', () => {
  it('typehashes y domain separator iguales a los de la Safe real', () => {
    expect(SAFE_DOMAIN_TYPEHASH).toBe(safeTxVectors.domainTypehash);
    expect(SAFE_TX_TYPEHASH).toBe(safeTxVectors.safeTxTypehash);
    expect(safeDomainSeparator(safeTxVectors.chainId, safeTxVectors.safe)).toBe(safeTxVectors.domainSeparator);
  });

  it('cubre los 12 tipos de operación de los vectores', () => {
    expect(safeTxVectors.operations.map((o) => o.opType).sort()).toEqual(Object.keys(EXPECTED_KIND).sort());
  });

  it.each(safeTxVectors.operations.map((o) => [o.opType, o] as const))('%s: SafeTxHash recalculado', (_op, vector) => {
    expect(safeTxHash(safeTxVectors.chainId, safeTxVectors.safe, toSafeTx(vector))).toBe(vector.safeTxHash);
    expect(isPlainCall(toSafeTx(vector))).toBe(true);
  });

  it.each(safeTxVectors.operations.map((o) => [o.opType, o] as const))(
    '%s: las firmas de U, S y R recuperan sus claves',
    async (_op, vector) => {
      expect(await recoverStrictSigner(vector.safeTxHash, vector.signatureUser)).toBe(system.keys.user.address);
      expect(await recoverStrictSigner(vector.safeTxHash, vector.signatureExecutor)).toBe(system.keys.executor.address);
      expect(await recoverStrictSigner(vector.safeTxHash, vector.signatureRecovery)).toBe(system.keys.recovery.address);
      const pair = splitSignatures(vector.signaturesUserExecutor);
      expect(pair).toHaveLength(2);
      const signers = await Promise.all(pair.map((s) => recoverStrictSigner(vector.safeTxHash, s)));
      // Safe exige las firmas ordenadas por dirección ascendente.
      expect(signers.map((a) => a.toLowerCase())).toEqual([...signers.map((a) => a.toLowerCase())].sort());
      expect(new Set(signers)).toEqual(new Set([system.keys.user.address, system.keys.executor.address]));
    },
  );
});

describe('decoder tipificado de la llamada interna', () => {
  it.each(safeTxVectors.operations.map((o) => [o.opType, o] as const))('%s', (opType, vector) => {
    const decoded = decodeSafeCall(system.contracts, system.safe, toSafeTx(vector));
    expect(decoded.kind).toBe(EXPECTED_KIND[opType]);
    switch (decoded.kind) {
      case 'ERC20_TRANSFER':
        expect(decoded.tokenAddress).toBe(getAddress(system.contracts.usdc));
        expect(decoded.amount > 0n).toBe(true);
        break;
      case 'ERC20_APPROVE':
        expect(decoded.spender).toBe(getAddress(system.contracts.swapExecutor));
        expect(decoded.amount === 0n).toBe(opType === 'APPROVE_REVOKE');
        break;
      case 'SWAP':
        expect(decoded.executor).toBe(getAddress(system.contracts.swapExecutor));
        expect(new Set([decoded.tokenIn, decoded.tokenOut])).toEqual(new Set(['USDC', 'USDT']));
        expect(decoded.minAmountOut <= decoded.amountIn).toBe(true);
        break;
      case 'SWAP_OWNER':
        expect(decoded.oldOwner).not.toBe(decoded.newOwner);
        expect(decoded.prevOwner).toMatch(/^0x[0-9a-fA-F]{40}$/);
        break;
      case 'SET_GUARD':
        expect(decoded.guard).toMatch(/^0x[0-9a-fA-F]{40}$/);
        break;
      case 'NOOP':
      case 'WHITELIST_ADD':
      case 'WHITELIST_REMOVE':
      case 'ROTATION_PROPOSE':
      case 'ROTATION_CANCEL':
      case 'SET_MODULE_GUARD':
        break;
    }
  });
});

describe('typed data de plataforma [W-01]', () => {
  const wire = load('wire/eip712.json') as {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    domainSeparator: Hex;
    types: {
      primaryType: PlatformPrimaryType;
      typehash: Hex;
      structHash: Hex;
      digest: Hex;
      signer: Address;
      signature: Hex;
      message: Record<string, unknown>;
    }[];
  };

  const asMessage = <T extends PlatformPrimaryType>(
    primaryType: T,
    raw: Record<string, unknown>,
  ): PlatformMessages[T] =>
    (primaryType === 'WalletCreationAuthorization'
      ? { ...raw, saltNonce: BigInt(raw.saltNonce as string) }
      : raw) as unknown as PlatformMessages[T];

  it('dominio "MTW Wallet" v1 sobre la WalletFactory', () => {
    expect(wire.domain.name).toBe('MTW Wallet');
    expect(domainSeparator(platformDomain(wire.domain.chainId, wire.domain.verifyingContract))).toBe(
      wire.domainSeparator,
    );
  });

  it('incluye los cuatro tipos de plataforma', () => {
    expect(wire.types.map((t) => t.primaryType).sort()).toEqual(
      ['KeyAcceptance', 'KeyRestore', 'RecoveryProofOfControl', 'WalletCreationAuthorization'].sort(),
    );
  });

  it.each(wire.types.map((t) => [t.primaryType, t] as const))(
    '%s: typehash, structHash, digest y firmante',
    async (primaryType, vector) => {
      const message = asMessage(primaryType, vector.message);
      expect(typeHash(primaryType)).toBe(vector.typehash);
      expect(platformStructHash(primaryType, message)).toBe(vector.structHash);
      const digest = platformDigest(wire.domain.chainId, wire.domain.verifyingContract, primaryType, message);
      expect(digest).toBe(vector.digest);
      expect(await recoverStrictSigner(digest, vector.signature)).toBe(vector.signer);
    },
  );
});

describe('CancelRotation (dominio MTW RotationTimelock)', () => {
  const cancel = load('cancel-rotation.json') as {
    domain: { name: string; chainId: number; verifyingContract: Address };
    message: { proposalId: Hex; safe: Address };
    digest: Hex;
    signatureUser: Hex;
    signatureRecovery: Hex;
  };

  it('digest igual al del contrato y firmas de U y R', async () => {
    expect(cancel.domain.name).toBe('MTW RotationTimelock');
    const digest = cancelRotationDigest(
      cancel.domain.chainId,
      cancel.domain.verifyingContract,
      cancel.message.proposalId,
      cancel.message.safe,
    );
    expect(digest).toBe(cancel.digest);
    expect(typeHash('CancelRotation')).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await recoverStrictSigner(digest, cancel.signatureUser)).toBe(system.keys.user.address);
    expect(await recoverStrictSigner(digest, cancel.signatureRecovery)).toBe(system.keys.recovery.address);
  });
});

describe('dirección CREATE2 de una Safe del sistema', () => {
  const create2 = load('create2.json') as {
    safeProxyFactory: Address;
    initCodeHash: Hex;
    safeBootstrap: Address;
    predictions: {
      userKey: Address;
      recoveryKey: Address;
      executor: Address;
      saltNonce: string;
      initializer: Hex;
      salt: Hex;
      predictedSafe: Address;
    }[];
  };

  it.each(create2.predictions.map((p, i) => [i, p] as const))('predicción %i', (_i, p) => {
    const initializer = safeInitializer(
      { userKey: p.userKey, recoveryKey: p.recoveryKey, executor: p.executor },
      create2.safeBootstrap,
    );
    expect(initializer).toBe(p.initializer.toLowerCase());
    expect(safeSalt(initializer, BigInt(p.saltNonce))).toBe(p.salt);
    expect(
      predictSafeAddress({
        safeProxyFactory: create2.safeProxyFactory,
        initCodeHash: create2.initCodeHash,
        initializer,
        saltNonce: BigInt(p.saltNonce),
      }),
    ).toBe(getAddress(p.predictedSafe));
  });
});
