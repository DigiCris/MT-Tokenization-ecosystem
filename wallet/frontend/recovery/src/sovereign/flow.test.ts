// P19.T06: el flujo soberano sin backend. Las acciones se arman con el nonce y los saldos leídos de la cadena, R firma
// el hash que calcula la app (la firma tiene que recuperar a R) y un documento se transmite sólo con firmas de U y R de
// owners vigentes distintos y con el nonce que sigue en la Safe.
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  padHex,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { iSafeAbi } from '../chain/abis/ISafe.ts';
import { SAFE_SLOTS } from '../chain/safe-check.ts';
import { safeTxTypedData } from '../chain/safe-tx.ts';
import { pinnedChain } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';
import { addressOfKey, signDigest } from '../crypto/secp256k1.ts';
import { typedDataDigest } from '../crypto/typed-data.ts';
import type { RecoverySigner } from '../signer/recovery-signer.ts';
import { toSafeTx, withSignature } from './document.ts';
import {
  buildActions,
  calldataFile,
  documentsFor,
  executionReadiness,
  readSovereignSafe,
  signWithRecovery,
  SovereignFlowError,
  type SovereignSafe,
} from './flow.ts';

const U_KEY = toBytes(keccak256(toBytes('mtw-user-key')));
const R_KEY = toBytes(keccak256(toBytes('mtw-recovery-key')));
const OTHER_KEY = toBytes(keccak256(toBytes('otra-clave')));
const U = addressOfKey(U_KEY);
const R = addressOfKey(R_KEY);
const S = getAddress('0x00000000000000000000000000000000000000a3');
const SAFE = getAddress('0x2Ffa853A9213C92A16295C55FA6A5b27A6498688');
const DEST = getAddress('0xde032ab8bcf44fb9dd7fb9c0d8e9ead8d2325e26');
const pinned = {
  chain: pinnedChain,
  system: {
    contracts: { guard: { address: getAddress('0x00000000000000000000000000000000000000f2') } },
  } as unknown as SystemContracts,
};
const state: SovereignSafe = {
  safe: SAFE,
  owners: [U, R, S],
  nonce: 7n,
  roles: { userKey: U, recoveryKey: R, executor: S },
  warnings: [],
};
const balances = {
  readContract: ({ functionName, address }: { functionName: string; address: Address }) => {
    if (functionName !== 'balanceOf') throw new Error(functionName);
    return Promise.resolve(address === pinnedChain.tokens.USDC.address ? 1_500_000n : 0n);
  },
} as never;

function keySigner(key: Uint8Array): RecoverySigner {
  return {
    kind: 'internal',
    address: addressOfKey(key),
    walletId: null,
    signTypedData: (definition) => Promise.resolve(signDigest(typedDataDigest(definition), key)),
    sendTransaction: null,
  };
}

async function userSigned(doc: Awaited<ReturnType<typeof signWithRecovery>>, key = U_KEY) {
  const definition = safeTxTypedData(8453, doc.safe, toSafeTx(doc));
  const digest = typedDataDigest({ ...definition, message: { ...definition.message } });
  return withSignature(doc, { signer: addressOfKey(key), role: 'U', signature: signDigest(digest, key) });
}

describe('acciones con datos de la cadena', () => {
  it('transferir todo el saldo de USDC con el nonce de la Safe', async () => {
    const [action] = await buildActions(balances, pinned, state, {
      type: 'TRANSFER',
      token: 'USDC',
      destination: DEST.toLowerCase(),
    });
    expect(action?.tx.nonce).toBe(7n);
    expect(action?.tx.to).toBe(pinnedChain.tokens.USDC.address);
    const call = decodeFunctionData({ abi: erc20Abi, data: action?.tx.data ?? '0x' });
    expect(call.args).toEqual([DEST, 1_500_000n]);
  });

  it('sin saldo, a la misma Safe o con una dirección mal escrita no se arma', async () => {
    await expect(
      buildActions(balances, pinned, state, { type: 'TRANSFER', token: 'USDT', destination: DEST }),
    ).rejects.toThrow('no tiene saldo');
    await expect(
      buildActions(balances, pinned, state, { type: 'TRANSFER', token: 'USDC', destination: SAFE }),
    ).rejects.toThrow(SovereignFlowError);
    const broken = `${DEST.slice(0, 3)}${DEST.charAt(3) === 'E' ? 'e' : 'E'}${DEST.slice(4)}`;
    await expect(
      buildActions(balances, pinned, state, { type: 'TRANSFER', token: 'USDC', destination: broken }),
    ).rejects.toThrow('checksum');
  });

  it('reemplazar S: swapOwner (N) y updateRoles (N+1); sin roles del Guard no se arma', async () => {
    const next = getAddress('0x00000000000000000000000000000000000000a4');
    const actions = await buildActions(balances, pinned, state, { type: 'EXECUTOR_REPLACEMENT', newExecutor: next });
    expect(actions.map((a) => [a.action.type, a.tx.nonce])).toEqual([
      ['EXECUTOR_REPLACEMENT_SWAP', 7n],
      ['EXECUTOR_REPLACEMENT_ROLES', 8n],
    ]);
    await expect(
      buildActions(balances, pinned, { ...state, roles: null }, { type: 'EXECUTOR_REPLACEMENT', newExecutor: next }),
    ).rejects.toThrow(SovereignFlowError);
  });

  it('retirar el Guard (dirección cero) y roles que no son owners', async () => {
    const [guard] = await buildActions(balances, pinned, state, { type: 'SET_GUARD', guard: '', remove: true });
    expect(decodeFunctionData({ abi: iSafeAbi, data: guard?.tx.data ?? '0x' }).args).toEqual([zeroAddress]);
    await expect(
      buildActions(balances, pinned, state, {
        type: 'UPDATE_ROLES',
        userKey: U,
        recoveryKey: R,
        executor: getAddress('0x00000000000000000000000000000000000000a9'),
      }),
    ).rejects.toThrow('no es owner');
  });

  it('actualizar los roles del Guard con tres owners distintos', async () => {
    const [roles] = await buildActions(balances, pinned, state, {
      type: 'UPDATE_ROLES',
      userKey: U,
      recoveryKey: R,
      executor: S,
    });
    expect(roles?.action).toEqual({ type: 'UPDATE_ROLES', params: { userKey: U, recoveryKey: R, executor: S } });
    expect(roles?.tx.to).toBe(pinned.system.contracts.guard.address);
  });

  it('NoOp sólo con un nonce entre el actual y los encolables', async () => {
    const [ok] = await buildActions(balances, pinned, state, { type: 'NOOP', nonce: '9' });
    expect(ok?.tx.nonce).toBe(9n);
    await expect(buildActions(balances, pinned, state, { type: 'NOOP', nonce: '6' })).rejects.toThrow('entre 7');
    await expect(buildActions(balances, pinned, state, { type: 'NOOP', nonce: '23' })).rejects.toThrow('entre 7');
    await expect(buildActions(balances, pinned, state, { type: 'NOOP', nonce: 'x' })).rejects.toThrow('entero');
  });
});

describe('firma de R y condiciones para transmitir', () => {
  async function signedByR() {
    const [action] = await buildActions(balances, pinned, state, { type: 'NOOP', nonce: '7' });
    if (!action) throw new Error('sin acción');
    const [doc] = documentsFor(SAFE, [action], new Date('2026-10-18T12:00:00Z'));
    if (!doc) throw new Error('sin documento');
    return signWithRecovery(doc, keySigner(R_KEY));
  }

  it('R firma el hash recalculado; con la firma de U se arma execTransaction', async () => {
    const doc = await signedByR();
    expect(doc.signatures.map((s) => [s.role, s.signer])).toEqual([['R', R]]);
    expect(await executionReadiness(doc, state)).toEqual({
      ready: false,
      reason: 'Falta la firma de U: exportá el documento y firmalo en la app Wallet.',
    });
    const both = await userSigned(doc);
    const readiness = await executionReadiness(both, state);
    expect(readiness.ready).toBe(true);
    if (readiness.ready) {
      const call = decodeFunctionData({ abi: iSafeAbi, data: readiness.data });
      expect(call.functionName).toBe('execTransaction');
      expect(JSON.parse(calldataFile(both, readiness.data))).toMatchObject({
        to: SAFE,
        data: readiness.data,
        value: '0',
      });
    }
  });

  it('una wallet que firma con otra cuenta no queda como R', async () => {
    const doc = (await signedByR()).signatures.length;
    expect(doc).toBe(1);
    const lying: RecoverySigner = { ...keySigner(OTHER_KEY), address: R };
    const [action] = await buildActions(balances, pinned, state, { type: 'NOOP', nonce: '7' });
    const [fresh] = documentsFor(SAFE, action ? [action] : [], new Date());
    if (!fresh) throw new Error('sin documento');
    await expect(signWithRecovery(fresh, lying)).rejects.toThrow('no es de tu clave R');
  });

  it('firmantes que ya no son owners, nonce usado o futuro: no se transmite', async () => {
    const both = await userSigned(await signedByR());
    expect(await executionReadiness(both, { owners: [R, S, getAddress(DEST)], nonce: 7n })).toMatchObject({
      ready: false,
      reason: 'La clave U que firmó ya no es owner de la Safe.',
    });
    expect(await executionReadiness(both, { ...state, nonce: 8n })).toMatchObject({ ready: false });
    expect(await executionReadiness(both, { ...state, nonce: 6n })).toMatchObject({
      ready: false,
      reason: 'Antes tiene que ejecutarse la operación con nonce 6 (esta usa el 7).',
    });
  });
});

describe('lectura de la Safe sin backend', () => {
  const singleton = getAddress('0x0000000000000000000000000000000000000051');
  const codes: Record<string, Hex> = { [SAFE]: '0x01', [singleton]: '0x02' };
  const system = {
    contracts: Object.fromEntries(
      ['guard', 'timelock', 'policyRegistry', 'whitelist', 'swapExecutor', 'bootstrap', 'factory', 'moduleGuard'].map(
        (role, i) => [
          role,
          { address: getAddress(padHex(`0x${(0xc0 + i).toString(16)}`, { size: 20 })), codehash: keccak256('0x') },
        ],
      ),
    ),
  } as unknown as SystemContracts;
  const chainPin = {
    ...pinnedChain,
    safe: {
      ...pinnedChain.safe,
      singletonL2: singleton,
      singletonL2Codehash: keccak256('0x02'),
      proxyRuntimeCodehash: keccak256('0x01'),
    },
  };
  function reader(registered: boolean, safeCode: Hex = '0x01') {
    return {
      getCode: ({ address }: { address: Address }) =>
        Promise.resolve(getAddress(address) === SAFE ? safeCode : (codes[getAddress(address)] ?? '0x')),
      getStorageAt: ({ slot }: { slot: Hex }) =>
        Promise.resolve(
          padHex(
            slot === SAFE_SLOTS.singleton
              ? singleton
              : slot === SAFE_SLOTS.guard
                ? system.contracts.guard.address
                : '0x',
            { size: 32 },
          ),
        ),
      readContract: ({ functionName }: { functionName: string }) =>
        Promise.resolve(
          (
            {
              getThreshold: 2n,
              isRegistered: registered,
              getOwners: [U, R, S],
              rolesOf: { initialized: true, userKey: U, recoveryKey: R, executor: S },
              nonce: 12n,
            } as Record<string, unknown>
          )[functionName],
        ),
    } as never;
  }

  it('owners, nonce y roles; lo que no coincide con la configuración asistida queda como aviso', async () => {
    const read = await readSovereignSafe(reader(true), { system, chain: chainPin }, SAFE);
    expect(read).toMatchObject({
      safe: SAFE,
      owners: [U, R, S],
      nonce: 12n,
      roles: { userKey: U, recoveryKey: R, executor: S },
    });
    expect(read.warnings).toEqual(['MODULE_GUARD']);
  });

  it('sin registro en el Guard no hay roles; si no es una Safe, no se usa', async () => {
    expect((await readSovereignSafe(reader(false), { system, chain: chainPin }, SAFE)).roles).toBeNull();
    await expect(readSovereignSafe(reader(true, '0x99'), { system, chain: chainPin }, SAFE)).rejects.toThrow(
      'no es una Safe',
    );
  });
});
