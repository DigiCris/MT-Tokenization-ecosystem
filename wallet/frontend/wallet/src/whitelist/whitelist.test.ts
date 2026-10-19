// P18.T05: destinos escritos por el usuario (EIP-55 o minúsculas, nunca la dirección cero), lista on-chain con los
// labels del backend (un label de una dirección que no está on-chain no aparece) y las SafeTx de alta y baja iguales
// a las del vector de contracts/.
import { getAddress, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import safeTxVectors from '../../test/vectors/safe-tx.json';
import systemVector from '../../test/vectors/system.json';
import type { WhitelistEntry, WhitelistRequest } from '../api/wallet-api.ts';
import { safeTxHash } from '../chain/safe-tx.ts';
import {
  activating,
  activationText,
  addDestinationCall,
  DestinationError,
  isActiveDestination,
  parseDestination,
  readWhitelist,
  removeDestinationCall,
} from './whitelist.ts';

const vectors = safeTxVectors as unknown as {
  safe: Address;
  operations: { opType: string; to: Address; data: `0x${string}`; nonce: number; safeTxHash: `0x${string}` }[];
};
const WL = (systemVector as unknown as { contracts: { destinationWhitelist: Address } }).contracts.destinationWhitelist;
const DEST: Address = getAddress('0xde032ab8bcf44fb9dd7fb9c0d8e9ead8d2325e26');

describe('destinos', () => {
  it('acepta EIP-55 válido o minúsculas y normaliza', () => {
    expect(parseDestination(` ${DEST.toLowerCase()} `)).toBe(getAddress(DEST));
    expect(parseDestination(getAddress(DEST))).toBe(getAddress(DEST));
  });

  it.each(['', '0x123', 'hola', '0x0000000000000000000000000000000000000000', getAddress(DEST).replace('D', 'd')])(
    'rechaza %s',
    (text) => {
      expect(() => parseDestination(text)).toThrow(DestinationError);
    },
  );

  it('alta y baja: las SafeTx del vector', () => {
    for (const [type, build] of [
      ['WHITELIST_ADD', addDestinationCall],
      ['WHITELIST_REMOVE', removeDestinationCall],
    ] as const) {
      const op = vectors.operations.find((o) => o.opType === type);
      if (!op) throw new Error(type);
      const tx = build(WL, DEST, BigInt(op.nonce));
      expect(tx.data).toBe(op.data);
      expect(safeTxHash(8453, vectors.safe, tx)).toBe(op.safeTxHash);
    }
  });
});

describe('lista on-chain', () => {
  const OTHER: Address = '0x00000000000000000000000000000000000000Aa';
  const reader = {
    readContract: ({ functionName, args }: { functionName: string; args: readonly Address[] }) => {
      if (functionName === 'destinationsOf') return Promise.resolve([DEST, OTHER]);
      if (functionName === 'isWhitelisted') return Promise.resolve(args[1] === DEST);
      return Promise.resolve(args[1] === DEST ? [true, 1_792_000_000n, true] : [true, 1_793_000_000n, false]);
    },
  } as never;
  const labels: WhitelistEntry[] = [
    {
      id: '1',
      destination: DEST,
      label: 'Cuenta de Ana',
      status: 'ACTIVE',
      activatesAt: null,
      activatedAt: null,
      origin: 'PLATFORM',
      addedTxHash: null,
    },
    {
      id: '2',
      destination: '0x000000000000000000000000000000000000bEEF',
      label: 'no está on-chain',
      status: 'ACTIVE',
      activatesAt: null,
      activatedAt: null,
      origin: 'PLATFORM',
      addedTxHash: null,
    },
  ];

  it('destinos de la cadena con los labels del backend', async () => {
    const list = await readWhitelist(reader, WL, vectors.safe, { entries: labels });
    expect(list).toEqual([
      { address: getAddress(DEST), label: 'Cuenta de Ana', active: true, activatesAt: new Date(1_792_000_000_000) },
      { address: getAddress(OTHER), label: null, active: false, activatesAt: new Date(1_793_000_000_000) },
    ]);
    expect(await isActiveDestination(reader, WL, vectors.safe, DEST)).toBe(true);
    expect(await isActiveDestination(reader, WL, vectors.safe, OTHER)).toBe(false);
  });

  it('un alta recién minada que el backend todavía no indexó toma el label de su pedido en curso', async () => {
    const request = (status: WhitelistRequest['status'], label: string): WhitelistRequest => ({
      id: label,
      walletId: 'w',
      destination: OTHER,
      label,
      status,
      challengeExpiresAt: null,
      operationId: null,
      failureReason: null,
      createdAt: '2026-10-18T00:00:00.000Z',
    });
    const inFlight = await readWhitelist(reader, WL, vectors.safe, {
      entries: labels,
      requests: [request('EXPIRED', 'vencido'), request('SUBMITTED', 'Proveedor')],
    });
    expect(inFlight[1]?.label).toBe('Proveedor');
    // Un pedido que no llegó a firmarse no le pone nombre a un destino on-chain.
    const unsigned = await readWhitelist(reader, WL, vectors.safe, {
      entries: labels,
      requests: [request('PENDING_CHALLENGE', 'sin firmar')],
    });
    expect(unsigned[1]?.label).toBeNull();
  });
});

describe('alerta de activación (ADR-006, P18.MAN)', () => {
  it('cuánto falta para que un destino se active, con la hora de la cadena', () => {
    const chainNow = Date.UTC(2026, 9, 19, 10, 0, 0);
    const at = new Date(chainNow + 23 * 3_600_000 + 12 * 60_000);
    expect(activationText(at, chainNow)).toBe('se activa en 23 h 12 min');
    expect(activationText(at, at.getTime())).toBe('ya se activó');
    expect(activationText(at, null)).toBe(`se activa el ${at.toLocaleString('es-AR')}`);
  });

  it('los destinos que todavía no se activaron', () => {
    const at = new Date(0);
    const list = [
      { address: DEST, label: 'Activo', active: true, activatesAt: at },
      { address: getAddress(`0x${'7'.repeat(40)}`), label: null, active: false, activatesAt: at },
    ];
    expect(activating(list).map((d) => d.label)).toEqual([null]);
  });
});
