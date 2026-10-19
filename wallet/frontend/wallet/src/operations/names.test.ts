// P18.MAN (B7, defensa en profundidad): un label de la whitelist es texto del usuario y no puede pasar por un nombre de
// la app. Se muestra entre «» (también los ya guardados) y al guardarlo se rechazan los nombres reservados («tu Safe»,
// «el contrato de swap de la plataforma»…, con o sin artículo, mayúsculas o tildes), las comillas « » y lo que parece
// una dirección. Un contrato del sistema nunca toma el label de un destino.
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { pinnedChain } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';
import {
  addressNames,
  labelProblem,
  labelsOf,
  POOL_NAME,
  RESERVED_NAMES,
  SAFE_NAME,
  shownLabels,
  userLabel,
} from './names.ts';

const A: Address = '0x000000000000000000000000000000000000dEaD';
const SAFE: Address = '0x00000000000000000000000000000000000000A1';
const EXECUTOR: Address = '0xF01c000000000000000000000000000000005830';
const system = {
  contracts: { swapExecutor: { name: 'SwapExecutorV3', address: EXECUTOR, codehash: '0x' } },
} as unknown as Pick<SystemContracts, 'contracts'>;

describe('labels de la whitelist', () => {
  it('se muestran entre «», distintos de los nombres de la app', () => {
    expect(userLabel('Cuenta de Ana')).toBe('«Cuenta de Ana»');
    const labels = labelsOf([
      { address: A, label: 'tu Safe' },
      { address: EXECUTOR, label: 'Otro nombre' },
    ]);
    const nameOf = addressNames({ safe: SAFE, chain: pinnedChain, system }, shownLabels(labels));
    // Un label ya guardado que imita un nombre de la app igual se ve como texto del usuario.
    expect(nameOf(A)).toBe('«tu Safe»');
    expect(nameOf(SAFE)).toBe(SAFE_NAME);
    expect(nameOf(EXECUTOR)).toBe('el contrato de swap de la plataforma');
    expect(nameOf(pinnedChain.uniswap.pool.address)).toBe(POOL_NAME);
    // Sin pasar por shownLabels, el label queda como lo escribió el usuario (p. ej. para el texto de un aviso).
    expect(addressNames({}, labels)(A)).toBe('tu Safe');
  });

  it.each([
    'tu Safe',
    'Safe',
    'mi safe',
    'TU SAFE',
    'el contrato de swap de la plataforma',
    'Contrato de swap de la plataforma',
    'El Guard de seguridad',
    'contrato de rotaciones',
    'el contrato de rotaciones (espera de 48 h)',
    'La fábrica de Safes',
    'fabrica de safes',
    'el contrato de USDC',
    'Pool USDC/USDT de Uniswap que usa la app',
  ])('rechaza "%s": es un nombre que usa la app', (label) => {
    expect(labelProblem(label)).toMatch(/es un nombre que la app usa para sus propias direcciones/);
  });

  it('cada nombre reservado se rechaza tal como lo muestra la app', () => {
    for (const name of RESERVED_NAMES) expect(labelProblem(name), name).not.toBeNull();
  });

  it.each([
    ['', 'Escribí un nombre para reconocer el destino.'],
    ['   ', 'Escribí un nombre para reconocer el destino.'],
    [
      '«Ana» y el contrato de swap',
      'El nombre no puede tener « ni »: la app los usa para marcar los nombres que escribís vos.',
    ],
    [
      'Cuenta 0x2c56 4BA9',
      'El nombre no puede incluir una dirección (0x…): la dirección completa ya se muestra al lado.',
    ],
    ['0x 2c56', 'El nombre no puede incluir una dirección (0x…): la dirección completa ya se muestra al lado.'],
  ])('rechaza "%s"', (label, problem) => {
    expect(labelProblem(label)).toBe(problem);
  });

  it.each(['Cuenta de Ana', 'Proveedor', 'Safe de Ana', 'Ahorros', 'Contrato con el proveedor', 'Box 0xford'])(
    'acepta "%s"',
    (label) => {
      expect(labelProblem(label)).toBeNull();
    },
  );
});
