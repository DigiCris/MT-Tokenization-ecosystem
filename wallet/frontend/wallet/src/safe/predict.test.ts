// P18.T02: la dirección esperada de la Safe que calcula la app reproduce el vector cruzado de contracts/
// (test/vectors/create2.json, generado en Solidity desde el fork): initializer, salt, init code hash del proxy y
// dirección; el creation code propio es el fijado (su keccak256 es el `proxyCreationCodeHash` de chain.base.json) y la
// regla del saltNonce da los mismos valores que en Solidity.
import { getAddress, keccak256, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import create2 from '../../test/vectors/create2.json';
import chainFile from '../config/chain.base.json';
import {
  SAFE_PROXY_CREATION_CODE,
  predictSafeAddress,
  safeInitializer,
  safeProxyInitCodeHash,
  safeSalt,
  walletSaltNonce,
} from './predict.ts';

interface Prediction {
  userKey: Address;
  recoveryKey: Address;
  executor: Address;
  saltNonce: string;
  initializer: Hex;
  salt: Hex;
  predictedSafe: Address;
}

const vector = create2 as unknown as {
  safeProxyFactory: Address;
  safeSingleton: Address;
  proxyCreationCodeHash: Hex;
  initCodeHash: Hex;
  safeBootstrap: Address;
  predictions: Prediction[];
  saltNonces: { platformId: string; walletId: string; saltNonce: string; predictedSafe: Address }[];
  proxyCreationCode: Hex;
};

const contracts = {
  safeProxyFactory: vector.safeProxyFactory,
  safeSingleton: vector.safeSingleton,
  safeBootstrap: vector.safeBootstrap,
};

describe('dirección esperada de la Safe (P18.T02)', () => {
  it('creation code del proxy: igual al del vector y al hash fijado en chain.base.json', () => {
    expect(SAFE_PROXY_CREATION_CODE).toBe(vector.proxyCreationCode);
    expect(keccak256(SAFE_PROXY_CREATION_CODE)).toBe(vector.proxyCreationCodeHash);
    expect(keccak256(SAFE_PROXY_CREATION_CODE)).toBe(chainFile.contracts.safeProxyFactory.proxyCreationCodeHash);
  });

  it('las direcciones de Safe del vector son las fijadas en chain.base.json', () => {
    expect(getAddress(vector.safeProxyFactory)).toBe(getAddress(chainFile.contracts.safeProxyFactory.address));
    expect(getAddress(vector.safeSingleton)).toBe(getAddress(chainFile.contracts.safeL2Singleton.address));
  });

  it('init code hash del proxy de la singleton SafeL2', () => {
    expect(safeProxyInitCodeHash(vector.safeSingleton)).toBe(vector.initCodeHash);
  });

  it.each(vector.predictions.map((p, i) => [i, p] as const))('predicción %i: initializer, salt y Safe', (_i, p) => {
    const keys = { userKey: p.userKey, recoveryKey: p.recoveryKey, executor: p.executor };
    const initializer = safeInitializer(keys, vector.safeBootstrap);
    expect(initializer).toBe(p.initializer.toLowerCase());
    expect(safeSalt(initializer, BigInt(p.saltNonce))).toBe(p.salt);
    expect(predictSafeAddress(keys, BigInt(p.saltNonce), contracts)).toBe(getAddress(p.predictedSafe));
  });

  it.each(vector.saltNonces.map((s) => [s.walletId, s] as const))('saltNonce de la wallet %s', (_id, s) => {
    const saltNonce = walletSaltNonce(s.platformId, s.walletId);
    expect(saltNonce).toBe(BigInt(s.saltNonce));
    const [first] = vector.predictions;
    if (first === undefined) throw new Error('vector sin predicciones');
    const keys = { userKey: first.userKey, recoveryKey: first.recoveryKey, executor: first.executor };
    expect(predictSafeAddress(keys, saltNonce, contracts)).toBe(getAddress(s.predictedSafe));
  });

  it('cambiar cualquier clave, el salt o la singleton cambia la dirección', () => {
    const [first] = vector.predictions;
    if (first === undefined) throw new Error('vector sin predicciones');
    const keys = { userKey: first.userKey, recoveryKey: first.recoveryKey, executor: first.executor };
    const base = predictSafeAddress(keys, 1n, contracts);
    expect(
      predictSafeAddress({ ...keys, recoveryKey: keys.executor, executor: keys.recoveryKey }, 1n, contracts),
    ).not.toBe(base);
    expect(predictSafeAddress(keys, 2n, contracts)).not.toBe(base);
    expect(predictSafeAddress(keys, 1n, { ...contracts, safeSingleton: keys.userKey })).not.toBe(base);
  });
});
