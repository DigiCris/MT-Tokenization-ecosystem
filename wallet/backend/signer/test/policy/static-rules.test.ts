// P11.T05 [B-SIG-06]: reglas estáticas evaluadas antes de cualquier E/S. Tabla de casos de rechazo por regla (SR-xx:
// SafeTx y tx de S; GT-xx: cuenta gas tank) más los casos aceptados de cada operación V1. Ninguna función de esta
// tabla toca la red ni la DB: dependen sólo del pedido y del snapshot firmado.
import { describe, expect, it } from 'vitest';
import type { Hex } from '../../src/crypto/bytes.ts';
import { selectorOf, type Address } from '../../src/crypto/keccak.ts';
import { encodeCall, encodeDynamicBytes, SELECTORS, wordAddress, wordUint } from '../../src/chain/abi.ts';
import type { SafeTx } from '../../src/chain/safe-tx.ts';
import type { OperationType } from '../../src/policy/operations.ts';
import {
  checkExecutorTxStatic,
  checkPlatformTxStatic,
  checkSafeTxStatic,
  STATIC_RULES,
  StaticRuleViolation,
  type StaticRuleId,
} from '../../src/policy/static-rules.ts';
import { vector, vectorSnapshot } from '../helpers/vectors.ts';

const snapshot = vectorSnapshot();
const system = vector<{ safe: Address; contracts: Record<string, Address> }>('system.json');
const SAFE = system.safe;
const C = system.contracts;
const DEST = '0xde032aB8bcf44fb9dd7FB9C0d8E9eaD8D2325e26' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

function tx(to: Address, data: Hex, overrides: Partial<SafeTx> = {}): SafeTx {
  return {
    to,
    value: 0n,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: 3n,
    ...overrides,
  };
}
const transfer = (amount = 1_000_000n) =>
  tx(C.usdc!, encodeCall(SELECTORS.transfer, wordAddress(DEST), wordUint(amount)));

function ruleOf(fn: () => unknown): StaticRuleId | 'OK' {
  try {
    fn();
    return 'OK';
  } catch (error) {
    if (error instanceof StaticRuleViolation) return error.rule;
    throw error;
  }
}

const safeTxCase =
  (safeTx: SafeTx, operationType: OperationType, extra: { chainId?: number; safe?: Address } = {}) =>
  () =>
    checkSafeTxStatic(snapshot, { chainId: extra.chainId ?? 8453, safe: extra.safe ?? SAFE, safeTx, operationType });

describe('reglas estáticas de la SafeTx (SR-01..SR-09)', () => {
  const rejections: [string, () => unknown, StaticRuleId][] = [
    ['chainId del pedido ≠ 8453', safeTxCase(transfer(), 'SEND', { chainId: 1 }), 'SR-01'],
    ['DELEGATECALL', safeTxCase({ ...transfer(), operation: 1 }, 'SEND'), 'SR-02'],
    ['operation fuera de rango', safeTxCase({ ...transfer(), operation: 2 }, 'SEND'), 'SR-02'],
    ['safeTxGas ≠ 0', safeTxCase({ ...transfer(), safeTxGas: 1n }, 'SEND'), 'SR-03'],
    ['baseGas ≠ 0', safeTxCase({ ...transfer(), baseGas: 21_000n }, 'SEND'), 'SR-03'],
    ['gasPrice ≠ 0', safeTxCase({ ...transfer(), gasPrice: 1n }, 'SEND'), 'SR-03'],
    ['gasToken ≠ 0', safeTxCase({ ...transfer(), gasToken: C.usdc! }, 'SEND'), 'SR-04'],
    ['refundReceiver ≠ 0', safeTxCase({ ...transfer(), refundReceiver: DEST }, 'SEND'), 'SR-04'],
    ['value > 0', safeTxCase({ ...transfer(), value: 1n }, 'SEND'), 'SR-05'],
    ['ETH a un destino externo', safeTxCase(tx(DEST, '0x', { value: 10n ** 18n }), 'SEND'), 'SR-05'],
    [
      'destino fuera de la allowlist',
      safeTxCase(tx(DEST, encodeCall(SELECTORS.transfer, wordAddress(DEST), wordUint(1n))), 'SEND'),
      'SR-06',
    ],
    [
      'transferFrom de un token',
      safeTxCase(
        tx(
          C.usdc!,
          encodeCall(
            selectorOf('transferFrom(address,address,uint256)'),
            wordAddress(SAFE),
            wordAddress(DEST),
            wordUint(1n),
          ),
        ),
        'SEND',
      ),
      'SR-06',
    ],
    [
      'permit de un token',
      safeTxCase(
        tx(
          C.usdc!,
          encodeCall(
            selectorOf('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'),
            wordAddress(SAFE),
            wordAddress(DEST),
            wordUint(1n),
            wordUint(1n),
            wordUint(27n),
            wordUint(1n),
            wordUint(1n),
          ),
        ),
        'SEND',
      ),
      'SR-06',
    ],
    [
      'approve a Permit2',
      safeTxCase(
        tx(
          C.usdc!,
          encodeCall(SELECTORS.approve, wordAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3'), wordUint(1n)),
        ),
        'SWAP_APPROVE',
      ),
      'SR-06',
    ],
    [
      'selector desconocido del SwapExecutor',
      safeTxCase(tx(C.swapExecutor!, encodeCall(selectorOf('rescue(address)'), wordAddress(DEST))), 'SWAP'),
      'SR-06',
    ],
    [
      'swap con tokenIn no soportado',
      safeTxCase(
        tx(C.swapExecutor!, encodeCall(SELECTORS.swap, wordAddress(DEST), wordUint(1n), wordUint(1n), wordUint(1n))),
        'SWAP',
      ),
      'SR-06',
    ],
    [
      'cancel del timelock por SafeTx',
      safeTxCase(tx(C.rotationTimelock!, encodeCall(SELECTORS.cancel, wordUint(1n))), 'ROTATION_PROPOSE'),
      'SR-06',
    ],
    [
      'markExecuted del timelock',
      safeTxCase(
        tx(C.rotationTimelock!, encodeCall(selectorOf('markExecuted(bytes32)'), wordUint(1n))),
        'ROTATION_PROPOSE',
      ),
      'SR-06',
    ],
    [
      'updateRoles del Guard',
      safeTxCase(
        tx(
          C.securityGuard!,
          encodeCall(
            selectorOf('updateRoles(address,address,address)'),
            wordAddress(DEST),
            wordAddress(DEST),
            wordAddress(DEST),
          ),
        ),
        'NOOP_CANCEL',
      ),
      'SR-06',
    ],
    [
      'changeThreshold de la Safe',
      safeTxCase(tx(SAFE, encodeCall(selectorOf('changeThreshold(uint256)'), wordUint(1n))), 'NOOP_CANCEL'),
      'SR-06',
    ],
    [
      'execTransaction anidado',
      safeTxCase(tx(SAFE, encodeCall(SELECTORS.execTransaction, wordAddress(DEST))), 'NOOP_CANCEL'),
      'SR-06',
    ],
    [
      'enableModule',
      safeTxCase(tx(SAFE, encodeCall(selectorOf('enableModule(address)'), wordAddress(DEST))), 'NOOP_CANCEL'),
      'SR-06',
    ],
    ['calldata de 3 bytes', safeTxCase(tx(SAFE, '0xa9059c'), 'NOOP_CANCEL'), 'SR-07'],
    [
      'transfer con bytes de más',
      safeTxCase(tx(C.usdc!, `${encodeCall(SELECTORS.transfer, wordAddress(DEST), wordUint(1n))}00`), 'SEND'),
      'SR-07',
    ],
    [
      'transfer con bytes de menos',
      safeTxCase(tx(C.usdc!, encodeCall(SELECTORS.transfer, wordAddress(DEST)).slice(0, -2) as Hex), 'SEND'),
      'SR-07',
    ],
    [
      'dirección no canónica',
      safeTxCase(
        tx(
          C.usdc!,
          encodeCall(
            SELECTORS.transfer,
            Uint8Array.from([...new Uint8Array(11), 1, ...wordAddress(DEST).subarray(12)]),
            wordUint(1n),
          ),
        ),
        'SEND',
      ),
      'SR-07',
    ],
    [
      'uint8 de rotación fuera de rango',
      safeTxCase(
        tx(C.rotationTimelock!, encodeCall(SELECTORS.propose, wordUint(256n), wordAddress(DEST), wordAddress(DEST))),
        'ROTATION_PROPOSE',
      ),
      'SR-07',
    ],
    [
      'tipo de rotación desconocido',
      safeTxCase(
        tx(C.rotationTimelock!, encodeCall(SELECTORS.propose, wordUint(9n), wordAddress(DEST), wordAddress(DEST))),
        'ROTATION_PROPOSE',
      ),
      'SR-07',
    ],
    ['hex inválido', safeTxCase(tx(C.usdc!, '0xzz'), 'SEND'), 'SR-07'],
    ['tipo declarado distinto (SEND → SWAP)', safeTxCase(transfer(), 'SWAP'), 'SR-08'],
    [
      'approve 0 declarado como SWAP_APPROVE',
      safeTxCase(
        tx(C.usdc!, encodeCall(SELECTORS.approve, wordAddress(C.swapExecutor!), wordUint(0n))),
        'SWAP_APPROVE',
      ),
      'SR-08',
    ],
    ['Safe = address(0)', safeTxCase(transfer(), 'SEND', { safe: ZERO }), 'SR-09'],
    ['Safe = contrato del sistema', safeTxCase(transfer(), 'SEND', { safe: C.securityGuard! }), 'SR-09'],
  ];

  it.each(rejections)('rechaza: %s', (_name, fn, rule) => {
    expect(ruleOf(fn)).toBe(rule);
  });

  it('cada regla SR de la SafeTx tiene al menos un caso de rechazo', () => {
    const covered = new Set(rejections.map(([, , rule]) => rule));
    for (const rule of ['SR-01', 'SR-02', 'SR-03', 'SR-04', 'SR-05', 'SR-06', 'SR-07', 'SR-08', 'SR-09'] as const) {
      expect(covered.has(rule)).toBe(true);
    }
  });

  const accepted: [OperationType, SafeTx, string][] = [
    ['NOOP_CANCEL', tx(SAFE, '0x'), 'NOOP_CANCEL'],
    ['SEND', transfer(), 'TRANSFER'],
    ['MIGRATION_TRANSFER', transfer(), 'TRANSFER'],
    [
      'SWAP_APPROVE',
      tx(C.usdt!, encodeCall(SELECTORS.approve, wordAddress(C.swapExecutor!), wordUint(5n))),
      'SWAP_APPROVE',
    ],
    [
      'APPROVE_REVOKE',
      tx(C.usdc!, encodeCall(SELECTORS.approve, wordAddress(C.swapExecutor!), wordUint(0n))),
      'APPROVE_REVOKE',
    ],
    [
      'SWAP',
      tx(C.swapExecutor!, encodeCall(SELECTORS.swap, wordAddress(C.usdc!), wordUint(5n), wordUint(4n), wordUint(9n))),
      'SWAP',
    ],
    [
      'WHITELIST_ADD',
      tx(C.destinationWhitelist!, encodeCall(SELECTORS.addDestination, wordAddress(DEST))),
      'WHITELIST_ADD',
    ],
    [
      'WHITELIST_REMOVE',
      tx(C.destinationWhitelist!, encodeCall(SELECTORS.removeDestination, wordAddress(DEST))),
      'WHITELIST_REMOVE',
    ],
    [
      'ROTATION_PROPOSE',
      tx(C.rotationTimelock!, encodeCall(SELECTORS.propose, wordUint(2n), wordAddress(DEST), wordAddress(C.usdc!))),
      'ROTATION_PROPOSE',
    ],
    [
      'ROTATION_EXECUTE',
      tx(SAFE, encodeCall(SELECTORS.swapOwner, wordAddress(DEST), wordAddress(DEST), wordAddress(DEST))),
      'ROTATION_EXECUTE',
    ],
    ['GUARD_UPGRADE', tx(SAFE, encodeCall(SELECTORS.setGuard, wordAddress(DEST))), 'GUARD_UPGRADE'],
    ['GUARD_UPGRADE', tx(SAFE, encodeCall(SELECTORS.setModuleGuard, wordAddress(DEST))), 'GUARD_UPGRADE'],
  ];
  it.each(accepted)('acepta la forma de %s', (type, safeTx, decoded) => {
    expect(checkSafeTxStatic(snapshot, { chainId: 8453, safe: SAFE, safeTx, operationType: type }).type).toBe(decoded);
  });
});

describe('reglas estáticas de la tx de S (SR-10..SR-14)', () => {
  const execData = encodeCall(SELECTORS.execTransaction, wordAddress(DEST));
  const base = {
    chainId: 8453,
    to: SAFE,
    value: 0n,
    data: execData,
    maxFeePerGas: 10n ** 9n,
    maxPriorityFeePerGas: 10n ** 8n,
    gasLimit: 300_000n,
  };
  const cases: [string, typeof base, StaticRuleId][] = [
    ['to ≠ Safe asociada', { ...base, to: DEST }, 'SR-10'],
    [
      'selector ≠ execTransaction',
      { ...base, data: encodeCall(SELECTORS.transfer, wordAddress(DEST), wordUint(1n)) },
      'SR-11',
    ],
    ['value > 0', { ...base, value: 1n }, 'SR-12'],
    ['chainId ≠ 8453', { ...base, chainId: 10 }, 'SR-13'],
    ['maxFeePerGas sobre el tope', { ...base, maxFeePerGas: snapshot.gas.maxFeePerGasWei + 1n }, 'SR-14'],
    [
      'priority fee sobre el tope',
      {
        ...base,
        maxFeePerGas: snapshot.gas.maxFeePerGasWei,
        maxPriorityFeePerGas: snapshot.gas.maxPriorityFeePerGasWei + 1n,
      },
      'SR-14',
    ],
    ['priority fee > max fee', { ...base, maxFeePerGas: 10n, maxPriorityFeePerGas: 11n }, 'SR-14'],
    ['gas sobre el tope', { ...base, gasLimit: BigInt(snapshot.gas.maxGasLimit) + 1n }, 'SR-14'],
    ['gas por debajo de 21.000', { ...base, gasLimit: 20_999n }, 'SR-14'],
    ['max fee 0', { ...base, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }, 'SR-14'],
  ];
  it.each(cases)('rechaza: %s', (_name, input, rule) => {
    expect(
      ruleOf(() => {
        checkExecutorTxStatic(snapshot, input, SAFE);
      }),
    ).toBe(rule);
  });
  it('acepta una execTransaction a la Safe asociada dentro de los topes', () => {
    expect(
      ruleOf(() => {
        checkExecutorTxStatic(snapshot, base, SAFE);
      }),
    ).toBe('OK');
  });
});

describe('reglas estáticas de la cuenta gas tank (GT-01..GT-06)', () => {
  const fees = { maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n, gasLimit: 100_000n };
  const signature = new Uint8Array(65).fill(7);
  const cancelData = encodeCall(
    SELECTORS.cancelWithSignature,
    wordUint(0xabn),
    wordUint(0x40n),
    encodeDynamicBytes(signature),
  );
  const createData = encodeCall(
    SELECTORS.createWallet,
    wordAddress(DEST),
    wordAddress(DEST),
    wordAddress(DEST),
    wordUint(0n),
  );
  type PlatformInput = Parameters<typeof checkPlatformTxStatic>[1];
  const topup: PlatformInput = { chainId: 8453, purpose: 'TOPUP', to: DEST, value: 10n ** 14n, data: '0x', ...fees };
  const deploy: PlatformInput = {
    chainId: 8453,
    purpose: 'DEPLOY',
    to: C.walletFactory!,
    value: 0n,
    data: createData,
    ...fees,
  };
  const relay: PlatformInput = {
    chainId: 8453,
    purpose: 'CANCEL_RELAY',
    to: C.rotationTimelock!,
    value: 0n,
    data: cancelData,
    ...fees,
  };
  const cases: [string, PlatformInput, StaticRuleId][] = [
    ['chainId ≠ 8453', { ...topup, chainId: 1 }, 'GT-01'],
    ['recarga sobre el tope', { ...topup, value: snapshot.gasTank.topupMaxWei + 1n }, 'GT-02'],
    ['recarga de 0', { ...topup, value: 0n }, 'GT-02'],
    ['recarga con calldata', { ...topup, data: '0x00' }, 'GT-02'],
    ['recarga a address(0)', { ...topup, to: ZERO }, 'GT-02'],
    ['recarga a un contrato del sistema', { ...topup, to: C.walletFactory! }, 'GT-02'],
    ['deploy a otro contrato', { ...deploy, to: DEST }, 'GT-03'],
    ['deploy con ETH', { ...deploy, value: 1n }, 'GT-03'],
    [
      'deploy con otro selector',
      {
        ...deploy,
        data: encodeCall(
          selectorOf('predictWalletAddress(address,address,address,uint256)'),
          wordAddress(DEST),
          wordAddress(DEST),
          wordAddress(DEST),
          wordUint(0n),
        ),
      },
      'GT-03',
    ],
    ['deploy con bytes de más', { ...deploy, data: `${createData}00` }, 'GT-03'],
    ['relay a otro contrato', { ...relay, to: DEST }, 'GT-04'],
    ['relay con ETH', { ...relay, value: 1n }, 'GT-04'],
    [
      'relay con firma de 64 bytes',
      {
        ...relay,
        data: encodeCall(
          SELECTORS.cancelWithSignature,
          wordUint(1n),
          wordUint(0x40n),
          encodeDynamicBytes(new Uint8Array(64)),
        ),
      },
      'GT-04',
    ],
    [
      'relay con offset no canónico',
      {
        ...relay,
        data: encodeCall(SELECTORS.cancelWithSignature, wordUint(1n), wordUint(0x60n), encodeDynamicBytes(signature)),
      },
      'GT-04',
    ],
    ['relay con basura en el padding', { ...relay, data: `${cancelData.slice(0, -2)}01` as Hex }, 'GT-04'],
    ['max fee sobre el tope', { ...topup, maxFeePerGas: snapshot.gas.maxFeePerGasWei + 1n }, 'GT-05'],
    ['gas sobre el tope del gas tank', { ...deploy, gasLimit: BigInt(snapshot.gasTank.maxGasLimit) + 1n }, 'GT-05'],
    ['hex inválido', { ...topup, data: '0xg' }, 'GT-06'],
  ];
  it.each(cases)('rechaza: %s', (_name, input, rule) => {
    expect(ruleOf(() => checkPlatformTxStatic(snapshot, input))).toBe(rule);
  });
  it('acepta las tres formas permitidas', () => {
    expect(checkPlatformTxStatic(snapshot, topup)).toMatchObject({ purpose: 'TOPUP', to: DEST });
    expect(checkPlatformTxStatic(snapshot, deploy)).toMatchObject({ purpose: 'DEPLOY', saltNonce: 0n });
    expect(checkPlatformTxStatic(snapshot, relay)).toMatchObject({ purpose: 'CANCEL_RELAY' });
  });
});

describe('tabla de reglas', () => {
  it('cada regla tiene descripción (revisada línea por línea en P11.MAN)', () => {
    expect(Object.keys(STATIC_RULES)).toHaveLength(20);
    for (const text of Object.values(STATIC_RULES)) expect(text.length).toBeGreaterThan(10);
  });
});
