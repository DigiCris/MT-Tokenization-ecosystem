// P12.T04: la dirección esperada se calcula en TS sin consultar a la WalletFactory. El creation code del proxy de Safe
// fijado en el backend es el del vector (generado del fork) y su keccak256 es el `proxyCreationCodeHash` de
// config/chains/base-mainnet.json; el saltNonce y las Safes predichas coinciden con los vectores generados en Solidity
// (abi.encode real y WalletFactory.predictWalletAddress).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { predictSafeAddress, safeInitializer } from '../../src/chain/create2.ts';
import { SAFE_PROXY_CREATION_CODE, safeProxyInitCodeHash } from '../../src/chain/safe-proxy.ts';
import { walletSaltNonce } from '../../src/wallets/salt.ts';

const vectors = JSON.parse(readFileSync(resolve(import.meta.dirname, '../vectors/create2.json'), 'utf8')) as {
  safeProxyFactory: Address;
  safeSingleton: Address;
  proxyCreationCodeHash: Hex;
  initCodeHash: Hex;
  safeBootstrap: Address;
  proxyCreationCode: Hex;
  predictions: {
    userKey: Address;
    recoveryKey: Address;
    executor: Address;
    saltNonce: string;
    initializer: Hex;
    predictedSafe: Address;
  }[];
  saltNonces: { platformId: string; walletId: string; saltNonce: string; predictedSafe: Address }[];
};
const chain = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../../config/chains/base-mainnet.json'), 'utf8'),
) as { contracts: { safeProxyFactory: { proxyCreationCodeHash: Hex } } };

describe('creation code del proxy de Safe y dirección esperada', () => {
  it('el creation code fijado es el del vector y su hash el de config/chains', () => {
    expect(SAFE_PROXY_CREATION_CODE).toBe(vectors.proxyCreationCode);
    expect(keccak256(SAFE_PROXY_CREATION_CODE)).toBe(chain.contracts.safeProxyFactory.proxyCreationCodeHash);
    expect(keccak256(SAFE_PROXY_CREATION_CODE)).toBe(vectors.proxyCreationCodeHash);
    expect(safeProxyInitCodeHash(vectors.safeSingleton)).toBe(vectors.initCodeHash);
  });

  it('initializer y Safe predicha de cada vector', () => {
    for (const p of vectors.predictions) {
      const initializer = safeInitializer(
        { userKey: p.userKey, recoveryKey: p.recoveryKey, executor: p.executor },
        vectors.safeBootstrap,
      );
      expect(initializer).toBe(p.initializer);
      const predicted = predictSafeAddress({
        safeProxyFactory: vectors.safeProxyFactory,
        initCodeHash: safeProxyInitCodeHash(vectors.safeSingleton),
        initializer,
        saltNonce: BigInt(p.saltNonce),
      });
      expect(predicted).toBe(p.predictedSafe);
    }
  });

  it('saltNonce = uint256(keccak256(abi.encode("MTW_SALT_V1", platformId, walletId))) y su Safe', () => {
    const keys = vectors.predictions[0];
    if (!keys) throw new Error('vector sin predicciones');
    for (const s of vectors.saltNonces) {
      const saltNonce = walletSaltNonce(s.platformId, s.walletId);
      expect(saltNonce.toString()).toBe(s.saltNonce);
      // La forma canónica del UUID es la minúscula (la que devuelve PostgreSQL).
      expect(walletSaltNonce(s.platformId, s.walletId.toUpperCase())).toBe(saltNonce);
      const predicted = predictSafeAddress({
        safeProxyFactory: vectors.safeProxyFactory,
        initCodeHash: safeProxyInitCodeHash(vectors.safeSingleton),
        initializer: safeInitializer(keys, vectors.safeBootstrap),
        saltNonce,
      });
      expect(predicted).toBe(s.predictedSafe);
    }
    expect(() => walletSaltNonce('mtw', 'no-es-un-uuid')).toThrow(/UUID/);
  });
});
