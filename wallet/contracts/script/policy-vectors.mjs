#!/usr/bin/env node
// Vectores de policy [B-POL-02/03/04], [W-07] (P11.T03 / P13.TST.j) en test/vectors/policy/policy.json: casos de
// decisión PURA (SafeTx + rol + scope + tipo declarado + hechos ya leídos on-chain y del ledger) con el veredicto que
// exige la especificación. Backend y signer los evalúan con sus implementaciones independientes y deben coincidir.
//
// La calldata se arma acá con node:crypto (selectores keccak-256 y ABI manual); los veredictos esperados están
// escritos a mano desde el planner (§7.9, §6.4), no calculados por ninguna de las dos implementaciones.
//
// Uso: node script/policy-vectors.mjs           escribe el archivo
//      node script/policy-vectors.mjs --check   falla si regenerar cambiaría el archivo
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(CONTRACTS, 'test/vectors/policy/policy.json');
const system = JSON.parse(readFileSync(join(CONTRACTS, 'test/vectors/system.json'), 'utf8'));
const chain = JSON.parse(readFileSync(join(CONTRACTS, '../config/chains/base-mainnet.json'), 'utf8'));
const check = process.argv.includes('--check');

const keccak256 = (b) => crypto.createHash('keccak-256').update(b).digest();
const selector = (sig) => keccak256(Buffer.from(sig, 'utf8')).subarray(0, 4).toString('hex');
const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uint = (v) => BigInt(v).toString(16).padStart(64, '0');
const call = (sig, ...words) => `0x${selector(sig)}${words.join('')}`;

const C = system.contracts;
const SAFE = system.safe;
const U = system.keys.user.address;
const R = system.keys.recovery.address;
const S = system.keys.executor.address;
const ZERO = '0x0000000000000000000000000000000000000000';
const SENTINEL = '0x0000000000000000000000000000000000000001';
const DEST = '0xde032aB8bcf44fb9dd7FB9C0d8E9eaD8D2325e26';
const DEST2 = '0x4E59b44847b379578588920cA78FbF26c0B4956C';
const NEW_KEY = '0x30680C97b8eFE2404915432e7e16115679417AbF';
const DAI = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const NEW_GUARD = '0x1111111111111111111111111111111111111111';
const NOW = 1792189500;
const USD = (n) => (BigInt(Math.round(n * 1_000_000))).toString();

const snapshot = {
  format: 'mtw-policy-snapshot',
  formatVersion: 1,
  version: 1,
  environment: 'local',
  platformId: 'mtw',
  chainId: 8453,
  issuedAt: '2026-10-17T00:00:00.000Z',
  contracts: {
    securityGuard: C.securityGuard,
    rotationTimelock: C.rotationTimelock,
    walletFactory: C.walletFactory,
    safeBootstrap: C.safeBootstrap,
    policyRegistry: C.policyRegistry,
    destinationWhitelist: C.destinationWhitelist,
    denyAllModuleGuard: C.denyAllModuleGuard,
    swapExecutor: C.swapExecutor,
    safeL2Singleton: chain.contracts.safeL2Singleton.address,
    safeProxyFactory: chain.contracts.safeProxyFactory.address,
  },
  tokens: [
    { symbol: 'USDC', address: C.usdc, decimals: 6 },
    { symbol: 'USDT', address: C.usdt, decimals: 6 },
  ],
  operations: {
    U: [
      'SEND',
      'SWAP_APPROVE',
      'SWAP',
      'APPROVE_REVOKE',
      'WHITELIST_ADD',
      'WHITELIST_REMOVE',
      'ROTATION_PROPOSE',
      'ROTATION_EXECUTE',
      'NOOP_CANCEL',
      'MIGRATION_TRANSFER',
      'GUARD_UPGRADE',
    ],
    R: ['NOOP_CANCEL', 'APPROVE_REVOKE', 'WHITELIST_REMOVE', 'ROTATION_PROPOSE', 'ROTATION_EXECUTE', 'MIGRATION_TRANSFER'],
  },
  // [B-POL-02] (ADR-025): montos en unidades de 6 decimales.
  limits: {
    perOperationMax: USD(10_000),
    dailyOutflowMax: USD(20_000),
    twoFactorThreshold: USD(1_000),
    swapMax: USD(10_000),
    minPerOperation: USD(1),
  },
  swap: { defaultSlippageBps: 30, maxSlippageBps: 50, deadlineSeconds: 600 },
  session: { maxSignatureAgeSeconds: 86400, clockSkewSeconds: 60 },
  gas: { maxFeePerGasWei: '10000000000', maxPriorityFeePerGasWei: '2000000000', maxGasLimit: 1500000 },
  gasTank: { topupMaxWei: '1000000000000000', dailyCapWei: '50000000000000000', maxGasLimit: 3000000 },
};

function safeTx(to, data, overrides = {}) {
  return {
    to,
    value: '0',
    data,
    operation: 0,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: '7',
    ...overrides,
  };
}

const transfer = (token, to, amount) => safeTx(token, call('transfer(address,uint256)', word(to), uint(amount)));
const approve = (token, spender, amount, o) => safeTx(token, call('approve(address,uint256)', word(spender), uint(amount)), o);
const swap = (tokenIn, amountIn, minOut, deadline, o) =>
  safeTx(C.swapExecutor, call('swap(address,uint256,uint256,uint256)', word(tokenIn), uint(amountIn), uint(minOut), uint(deadline)), o);
const wlAdd = (d) => safeTx(C.destinationWhitelist, call('addDestination(address)', word(d)));
const wlRemove = (d) => safeTx(C.destinationWhitelist, call('removeDestination(address)', word(d)));
// kind: enum RotationKind de los contratos (0 = U, 1 = R, 2 = S, 3 = GUARD, 4 = MODULE_GUARD).
const propose = (kind, oldV, newV) => safeTx(C.rotationTimelock, call('propose(uint8,address,address)', uint(kind), word(oldV), word(newV)));
const swapOwner = (prev, oldO, newO) => safeTx(SAFE, call('swapOwner(address,address,address)', word(prev), word(oldO), word(newO)));
const noop = () => safeTx(SAFE, '0x');

const roles = { userKey: U, recoveryKey: R, executor: S };
const baseFacts = { now: NOW, roles, dailyOutflowUsed: '0' };
const minOut = (amountIn, bps) => ((BigInt(amountIn) * BigInt(10_000 - bps)) / 10_000n).toString();

const cases = [];
function add(name, input, expected) {
  cases.push({ name, input: { safe: SAFE, ...input, facts: { ...baseFacts, ...input.facts } }, expected });
}
const ACCEPT = { verdict: 'ACCEPT' };
const REJECT = (code) => ({ verdict: 'REJECT', code });
const sendFacts = (o = {}) => ({ balance: USD(50_000), destinationWhitelisted: true, migrationAuthorized: false, ...o });
const asU = { role: 'U', scope: 'OPERATIONS' };
const asR = { role: 'R', scope: 'RECOVERY' };

// --- SEND -----------------------------------------------------------------------------------------------------
add('send: 100 USDC a destino whitelisteado', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, DEST, USD(100)), facts: sendFacts() }, ACCEPT);
add('send: USDT', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdt, DEST, USD(250)), facts: sendFacts() }, ACCEPT);
add('send: debajo del mínimo (0,5)', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, DEST, USD(0.5)), facts: sendFacts() }, REJECT('BELOW_MINIMUM'));
add('send: monto 0', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, DEST, '0'), facts: sendFacts() }, REJECT('BELOW_MINIMUM'));
add('send: supera el límite por operación', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, DEST, '10000000001'), facts: sendFacts({ twoFactorVerified: true }) }, REJECT('LIMIT_PER_OPERATION'));
add('send: exactamente el límite por operación (con 2FA)', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, DEST, USD(10_000)), facts: sendFacts({ twoFactorVerified: true }) }, ACCEPT);
add('send: supera la salida acumulada de 24 h', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, DEST, USD(6_000)), facts: sendFacts({ dailyOutflowUsed: USD(15_000), twoFactorVerified: true }) }, REJECT('LIMIT_DAILY'));
add('send: llega exacto al tope de 24 h', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, DEST, USD(10_000)), facts: sendFacts({ dailyOutflowUsed: USD(10_000), twoFactorVerified: true }) }, ACCEPT);
add('send: destino no whitelisteado', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, DEST, USD(100)), facts: sendFacts({ destinationWhitelisted: false }) }, REJECT('DESTINATION_NOT_WHITELISTED'));
add('send: saldo insuficiente', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, DEST, USD(100)), facts: sendFacts({ balance: USD(99) }) }, REJECT('INSUFFICIENT_BALANCE'));
add('send: 1.000 sin 2FA', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, DEST, USD(1_000)), facts: sendFacts() }, REJECT('TWO_FACTOR_REQUIRED'));
add('send: 1.000 con 2FA', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, DEST, USD(1_000)), facts: sendFacts({ twoFactorVerified: true }) }, ACCEPT);
add('send: 999,999999 sin 2FA', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, DEST, '999999999'), facts: sendFacts() }, ACCEPT);
add('send: a un contrato del sistema', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, C.swapExecutor, USD(100)), facts: sendFacts() }, REJECT('DESTINATION_FORBIDDEN'));
add('send: a un token soportado', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, C.usdt, USD(100)), facts: sendFacts() }, REJECT('DESTINATION_FORBIDDEN'));
add('send: a la propia Safe', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, SAFE, USD(100)), facts: sendFacts() }, REJECT('DESTINATION_FORBIDDEN'));
add('send: a address(0)', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, ZERO, USD(100)), facts: sendFacts() }, REJECT('DESTINATION_FORBIDDEN'));
add('send: firmado por R', { ...asR, declaredType: 'SEND', safeTx: transfer(C.usdc, DEST, USD(100)), facts: sendFacts() }, REJECT('OPERATION_NOT_ALLOWED'));
add('send: U con scope RECOVERY', { role: 'U', scope: 'RECOVERY', declaredType: 'SEND', safeTx: transfer(C.usdc, DEST, USD(100)), facts: sendFacts() }, REJECT('OPERATION_NOT_ALLOWED'));
add('send: scope ONBOARDING', { role: 'U', scope: 'ONBOARDING', declaredType: 'SEND', safeTx: transfer(C.usdc, DEST, USD(100)), facts: sendFacts() }, REJECT('OPERATION_NOT_ALLOWED'));
add('send: declarado como migración sin autorización', { ...asU, declaredType: 'MIGRATION_TRANSFER', safeTx: transfer(C.usdc, DEST, USD(100)), facts: sendFacts() }, REJECT('OPERATION_TYPE_MISMATCH'));
add('send: declarado SWAP', { ...asU, declaredType: 'SWAP', safeTx: transfer(C.usdc, DEST, USD(100)), facts: sendFacts() }, REJECT('OPERATION_TYPE_MISMATCH'));

// --- Estructura e allowlist ([C-GRD-03] paso 5, [C-DEC]) ------------------------------------------------------
add('estructura: DELEGATECALL', { ...asU, declaredType: 'SEND', safeTx: { ...transfer(C.usdc, DEST, USD(100)), operation: 1 }, facts: sendFacts() }, REJECT('UNKNOWN_OPERATION'));
add('estructura: value > 0', { ...asU, declaredType: 'SEND', safeTx: { ...transfer(C.usdc, DEST, USD(100)), value: '1' }, facts: sendFacts() }, REJECT('UNKNOWN_OPERATION'));
add('estructura: safeTxGas ≠ 0', { ...asU, declaredType: 'SEND', safeTx: { ...transfer(C.usdc, DEST, USD(100)), safeTxGas: '1' }, facts: sendFacts() }, REJECT('UNKNOWN_OPERATION'));
add('estructura: gasPrice ≠ 0', { ...asU, declaredType: 'SEND', safeTx: { ...transfer(C.usdc, DEST, USD(100)), gasPrice: '1' }, facts: sendFacts() }, REJECT('UNKNOWN_OPERATION'));
add('estructura: refundReceiver ≠ 0', { ...asU, declaredType: 'SEND', safeTx: { ...transfer(C.usdc, DEST, USD(100)), refundReceiver: DEST }, facts: sendFacts() }, REJECT('UNKNOWN_OPERATION'));
add('calldata: transfer con un byte de más', { ...asU, declaredType: 'SEND', safeTx: safeTx(C.usdc, `${call('transfer(address,uint256)', word(DEST), uint(USD(100)))}00`), facts: sendFacts() }, REJECT('UNKNOWN_OPERATION'));
add('calldata: dirección no canónica', { ...asU, declaredType: 'SEND', safeTx: safeTx(C.usdc, call('transfer(address,uint256)', `ff${word(DEST).slice(2)}`, uint(USD(100)))), facts: sendFacts() }, REJECT('UNKNOWN_OPERATION'));
add('calldata: 3 bytes', { ...asU, declaredType: 'NOOP_CANCEL', safeTx: safeTx(SAFE, '0xa9059c') }, REJECT('UNKNOWN_OPERATION'));
add('allowlist: token no soportado (DAI)', { ...asU, declaredType: 'SEND', safeTx: transfer(DAI, DEST, USD(100)), facts: sendFacts() }, REJECT('UNKNOWN_OPERATION'));
add('allowlist: transferFrom', { ...asU, declaredType: 'SEND', safeTx: safeTx(C.usdc, call('transferFrom(address,address,uint256)', word(SAFE), word(DEST), uint(USD(100)))), facts: sendFacts() }, REJECT('UNKNOWN_OPERATION'));
add('allowlist: increaseAllowance', { ...asU, declaredType: 'SWAP_APPROVE', safeTx: safeTx(C.usdc, call('increaseAllowance(address,uint256)', word(C.swapExecutor), uint(USD(100)))), facts: sendFacts() }, REJECT('UNKNOWN_OPERATION'));
add('allowlist: approve a Permit2', { ...asU, declaredType: 'SWAP_APPROVE', safeTx: approve(C.usdc, PERMIT2, USD(100)), facts: sendFacts() }, REJECT('UNKNOWN_OPERATION'));
add('allowlist: contrato arbitrario', { ...asU, declaredType: 'SEND', safeTx: safeTx(DEST2, call('transfer(address,uint256)', word(DEST), uint(USD(100)))), facts: sendFacts() }, REJECT('UNKNOWN_OPERATION'));
add('allowlist: changeThreshold en la Safe', { ...asU, declaredType: 'NOOP_CANCEL', safeTx: safeTx(SAFE, call('changeThreshold(uint256)', uint(1))) }, REJECT('UNKNOWN_OPERATION'));
add('allowlist: addOwnerWithThreshold', { ...asU, declaredType: 'NOOP_CANCEL', safeTx: safeTx(SAFE, call('addOwnerWithThreshold(address,uint256)', word(DEST), uint(1))) }, REJECT('UNKNOWN_OPERATION'));
add('allowlist: enableModule', { ...asU, declaredType: 'NOOP_CANCEL', safeTx: safeTx(SAFE, call('enableModule(address)', word(DEST))) }, REJECT('UNKNOWN_OPERATION'));
add('allowlist: setFallbackHandler', { ...asU, declaredType: 'NOOP_CANCEL', safeTx: safeTx(SAFE, call('setFallbackHandler(address)', word(DEST))) }, REJECT('UNKNOWN_OPERATION'));
add('allowlist: cancel del timelock por SafeTx', { ...asU, declaredType: 'ROTATION_PROPOSE', safeTx: safeTx(C.rotationTimelock, call('cancel(bytes32)', word('0x64a019b6fcae807e9cb9c9016136f55bd5e7fb01ada54826f752657e96e3a42c'))) }, REJECT('UNKNOWN_OPERATION'));
add('allowlist: tipo de rotación desconocido (5)', { ...asU, declaredType: 'ROTATION_PROPOSE', safeTx: propose(5, S, NEW_KEY) }, REJECT('UNKNOWN_OPERATION'));

// --- MIGRATION_TRANSFER ---------------------------------------------------------------------------------------
add('migración: saldo completo a la Safe nueva autorizada (U)', { ...asU, declaredType: 'MIGRATION_TRANSFER', safeTx: transfer(C.usdc, DEST2, USD(50_000)), facts: sendFacts({ migrationAuthorized: true, destinationWhitelisted: false }) }, ACCEPT);
add('migración: firmada por R', { ...asR, declaredType: 'MIGRATION_TRANSFER', safeTx: transfer(C.usdt, DEST2, USD(1_234)), facts: sendFacts({ balance: USD(1_234), migrationAuthorized: true, destinationWhitelisted: false }) }, ACCEPT);
add('migración: exenta del tope de 24 h', { ...asU, declaredType: 'MIGRATION_TRANSFER', safeTx: transfer(C.usdc, DEST2, USD(50_000)), facts: sendFacts({ migrationAuthorized: true, dailyOutflowUsed: USD(20_000) }) }, ACCEPT);
add('migración: parcial', { ...asU, declaredType: 'MIGRATION_TRANSFER', safeTx: transfer(C.usdc, DEST2, USD(100)), facts: sendFacts({ migrationAuthorized: true }) }, REJECT('MIGRATION_PARTIAL'));
add('migración: declarada SEND con destino autorizado', { ...asU, declaredType: 'SEND', safeTx: transfer(C.usdc, DEST2, USD(100)), facts: sendFacts({ migrationAuthorized: true }) }, REJECT('OPERATION_TYPE_MISMATCH'));

// --- SWAP_APPROVE / SWAP / APPROVE_REVOKE ---------------------------------------------------------------------
const pairedOk = (amount, o = {}) => ({ safeTx: swap(C.usdc, amount, minOut(amount, 30), NOW + 600, { nonce: '8' }), ownerSignatureValid: true, ...o });
add('approve: con su SWAP N+1 emparejado', { ...asU, declaredType: 'SWAP_APPROVE', safeTx: approve(C.usdc, C.swapExecutor, USD(500)), facts: { balance: USD(1_000), pairedSwap: pairedOk(USD(500)) } }, ACCEPT);
add('approve: sin SWAP emparejado', { ...asU, declaredType: 'SWAP_APPROVE', safeTx: approve(C.usdc, C.swapExecutor, USD(500)), facts: { balance: USD(1_000), pairedSwap: null } }, REJECT('SWAP_PAIRING_INVALID'));
add('approve: SWAP con otro monto', { ...asU, declaredType: 'SWAP_APPROVE', safeTx: approve(C.usdc, C.swapExecutor, USD(500)), facts: { balance: USD(1_000), pairedSwap: pairedOk(USD(499)) } }, REJECT('SWAP_PAIRING_INVALID'));
add('approve: SWAP con otro nonce', { ...asU, declaredType: 'SWAP_APPROVE', safeTx: approve(C.usdc, C.swapExecutor, USD(500)), facts: { balance: USD(1_000), pairedSwap: { ...pairedOk(USD(500)), safeTx: swap(C.usdc, USD(500), minOut(USD(500), 30), NOW + 600, { nonce: '9' }) } } }, REJECT('SWAP_PAIRING_INVALID'));
add('approve: SWAP con otro token', { ...asU, declaredType: 'SWAP_APPROVE', safeTx: approve(C.usdc, C.swapExecutor, USD(500)), facts: { balance: USD(1_000), pairedSwap: { ...pairedOk(USD(500)), safeTx: swap(C.usdt, USD(500), minOut(USD(500), 30), NOW + 600, { nonce: '8' }) } } }, REJECT('SWAP_PAIRING_INVALID'));
add('approve: SWAP sin firma válida de U', { ...asU, declaredType: 'SWAP_APPROVE', safeTx: approve(C.usdc, C.swapExecutor, USD(500)), facts: { balance: USD(1_000), pairedSwap: pairedOk(USD(500), { ownerSignatureValid: false }) } }, REJECT('SWAP_PAIRING_INVALID'));
add('approve: el SWAP emparejado excede el slippage', { ...asU, declaredType: 'SWAP_APPROVE', safeTx: approve(C.usdc, C.swapExecutor, USD(500)), facts: { balance: USD(1_000), pairedSwap: { ...pairedOk(USD(500)), safeTx: swap(C.usdc, USD(500), minOut(USD(500), 51), NOW + 600, { nonce: '8' }) } } }, REJECT('SLIPPAGE_TOO_HIGH'));
add('approve: supera el máximo de swap', { ...asU, declaredType: 'SWAP_APPROVE', safeTx: approve(C.usdc, C.swapExecutor, '10000000001'), facts: { balance: USD(20_000), pairedSwap: pairedOk('10000000001') } }, REJECT('SWAP_LIMIT'));
add('approve: saldo insuficiente', { ...asU, declaredType: 'SWAP_APPROVE', safeTx: approve(C.usdc, C.swapExecutor, USD(500)), facts: { balance: USD(499), pairedSwap: pairedOk(USD(500)) } }, REJECT('INSUFFICIENT_BALANCE'));
add('approve: firmado por R', { ...asR, declaredType: 'SWAP_APPROVE', safeTx: approve(C.usdc, C.swapExecutor, USD(500)), facts: { balance: USD(1_000), pairedSwap: pairedOk(USD(500)) } }, REJECT('OPERATION_NOT_ALLOWED'));
const swapFacts = (amount, o = {}) => ({ balance: USD(1_000), allowance: amount, approvalSigned: true, ...o });
add('swap: tras el approve ejecutado', { ...asU, declaredType: 'SWAP', safeTx: swap(C.usdc, USD(500), minOut(USD(500), 30), NOW + 300), facts: swapFacts(USD(500)) }, ACCEPT);
add('swap: slippage de 50 bps exacto', { ...asU, declaredType: 'SWAP', safeTx: swap(C.usdt, USD(500), minOut(USD(500), 50), NOW + 300), facts: swapFacts(USD(500)) }, ACCEPT);
add('swap: slippage de 51 bps', { ...asU, declaredType: 'SWAP', safeTx: swap(C.usdc, USD(500), minOut(USD(500), 51), NOW + 300), facts: swapFacts(USD(500)) }, REJECT('SLIPPAGE_TOO_HIGH'));
add('swap: deadline vencido', { ...asU, declaredType: 'SWAP', safeTx: swap(C.usdc, USD(500), minOut(USD(500), 30), NOW - 1), facts: swapFacts(USD(500)) }, REJECT('DEADLINE_INVALID'));
add('swap: deadline demasiado lejano', { ...asU, declaredType: 'SWAP', safeTx: swap(C.usdc, USD(500), minOut(USD(500), 30), NOW + 600 + 60 + 1), facts: swapFacts(USD(500)) }, REJECT('DEADLINE_INVALID'));
add('swap: sin approve co-firmado', { ...asU, declaredType: 'SWAP', safeTx: swap(C.usdc, USD(500), minOut(USD(500), 30), NOW + 300), facts: swapFacts(USD(500), { approvalSigned: false }) }, REJECT('SWAP_PAIRING_INVALID'));
add('swap: allowance distinta de amountIn', { ...asU, declaredType: 'SWAP', safeTx: swap(C.usdc, USD(500), minOut(USD(500), 30), NOW + 300), facts: swapFacts(USD(400)) }, REJECT('SWAP_PAIRING_INVALID'));
add('swap: supera el máximo', { ...asU, declaredType: 'SWAP', safeTx: swap(C.usdc, '10000000001', minOut('10000000001', 30), NOW + 300), facts: swapFacts('10000000001', { balance: USD(20_000) }) }, REJECT('SWAP_LIMIT'));
add('swap: tokenIn no soportado', { ...asU, declaredType: 'SWAP', safeTx: swap(DAI, USD(500), minOut(USD(500), 30), NOW + 300), facts: swapFacts(USD(500)) }, REJECT('UNKNOWN_OPERATION'));
add('swap: firmado por R', { ...asR, declaredType: 'SWAP', safeTx: swap(C.usdc, USD(500), minOut(USD(500), 30), NOW + 300), facts: swapFacts(USD(500)) }, REJECT('OPERATION_NOT_ALLOWED'));
add('revocación: U', { ...asU, declaredType: 'APPROVE_REVOKE', safeTx: approve(C.usdc, C.swapExecutor, '0') }, ACCEPT);
add('revocación: R', { ...asR, declaredType: 'APPROVE_REVOKE', safeTx: approve(C.usdt, C.swapExecutor, '0') }, ACCEPT);
add('revocación: declarada SWAP_APPROVE', { ...asU, declaredType: 'SWAP_APPROVE', safeTx: approve(C.usdc, C.swapExecutor, '0') }, REJECT('OPERATION_TYPE_MISMATCH'));

// --- WHITELIST ------------------------------------------------------------------------------------------------
add('whitelist: alta con challenge completado', { ...asU, declaredType: 'WHITELIST_ADD', safeTx: wlAdd(DEST), facts: { whitelistChallengeVerified: true } }, ACCEPT);
add('whitelist: alta sin challenge', { ...asU, declaredType: 'WHITELIST_ADD', safeTx: wlAdd(DEST), facts: { whitelistChallengeVerified: false } }, REJECT('CHALLENGE_REQUIRED'));
add('whitelist: alta de un contrato del sistema', { ...asU, declaredType: 'WHITELIST_ADD', safeTx: wlAdd(C.securityGuard), facts: { whitelistChallengeVerified: true } }, REJECT('DESTINATION_FORBIDDEN'));
add('whitelist: alta de la propia Safe', { ...asU, declaredType: 'WHITELIST_ADD', safeTx: wlAdd(SAFE), facts: { whitelistChallengeVerified: true } }, REJECT('DESTINATION_FORBIDDEN'));
add('whitelist: alta firmada por R', { ...asR, declaredType: 'WHITELIST_ADD', safeTx: wlAdd(DEST), facts: { whitelistChallengeVerified: true } }, REJECT('OPERATION_NOT_ALLOWED'));
add('whitelist: baja por U', { ...asU, declaredType: 'WHITELIST_REMOVE', safeTx: wlRemove(DEST) }, ACCEPT);
add('whitelist: baja por R', { ...asR, declaredType: 'WHITELIST_REMOVE', safeTx: wlRemove(DEST) }, ACCEPT);
add('whitelist: calldata con bytes de más', { ...asU, declaredType: 'WHITELIST_ADD', safeTx: safeTx(C.destinationWhitelist, `${call('addDestination(address)', word(DEST))}0000`), facts: { whitelistChallengeVerified: true } }, REJECT('UNKNOWN_OPERATION'));

// --- NOOP y scopes --------------------------------------------------------------------------------------------
add('noop: U', { ...asU, declaredType: 'NOOP_CANCEL', safeTx: noop() }, ACCEPT);
add('noop: R', { ...asR, declaredType: 'NOOP_CANCEL', safeTx: noop() }, ACCEPT);
add('scope: U_REPLACEMENT no co-firma', { role: 'U', scope: 'U_REPLACEMENT', declaredType: 'NOOP_CANCEL', safeTx: noop() }, REJECT('OPERATION_NOT_ALLOWED'));
add('scope: KEY_RESTORE no co-firma', { role: 'U', scope: 'KEY_RESTORE', declaredType: 'NOOP_CANCEL', safeTx: noop() }, REJECT('OPERATION_NOT_ALLOWED'));
add('scope: ENROLLMENT no co-firma', { role: 'R', scope: 'ENROLLMENT', declaredType: 'NOOP_CANCEL', safeTx: noop() }, REJECT('OPERATION_NOT_ALLOWED'));
add('scope: R con OPERATIONS', { role: 'R', scope: 'OPERATIONS', declaredType: 'NOOP_CANCEL', safeTx: noop() }, REJECT('OPERATION_NOT_ALLOWED'));

// --- ROTATION_PROPOSE -----------------------------------------------------------------------------------------
add('rotación: U propone S hacia una clave del signer', { ...asU, declaredType: 'ROTATION_PROPOSE', safeTx: propose(2, S, NEW_KEY), facts: { newKeyIsSignerKey: true } }, ACCEPT);
add('rotación: S hacia una clave ajena', { ...asU, declaredType: 'ROTATION_PROPOSE', safeTx: propose(2, S, NEW_KEY), facts: { newKeyIsSignerKey: false } }, REJECT('ROTATION_TARGET_NOT_SIGNER_KEY'));
add('rotación: U propone U con KeyAcceptance', { ...asU, declaredType: 'ROTATION_PROPOSE', safeTx: propose(0, U, NEW_KEY), facts: { keyAcceptanceValid: true } }, ACCEPT);
add('rotación: U sin KeyAcceptance', { ...asU, declaredType: 'ROTATION_PROPOSE', safeTx: propose(0, U, NEW_KEY), facts: { keyAcceptanceValid: false } }, REJECT('KEY_ACCEPTANCE_REQUIRED'));
add('rotación: R propone U (recovery)', { ...asR, declaredType: 'ROTATION_PROPOSE', safeTx: propose(0, U, NEW_KEY), facts: { keyAcceptanceValid: true } }, ACCEPT);
add('rotación: U propone R con KeyAcceptance', { ...asU, declaredType: 'ROTATION_PROPOSE', safeTx: propose(1, R, NEW_KEY), facts: { keyAcceptanceValid: true } }, ACCEPT);
add('rotación: R propone R', { ...asR, declaredType: 'ROTATION_PROPOSE', safeTx: propose(1, R, NEW_KEY), facts: { keyAcceptanceValid: true } }, REJECT('ROTATION_INVALID'));
add('rotación: R propone GUARD', { ...asR, declaredType: 'ROTATION_PROPOSE', safeTx: propose(3, C.securityGuard, NEW_GUARD), facts: { currentGuard: C.securityGuard, successorRegistered: true } }, REJECT('ROTATION_INVALID'));
add('rotación: old distinto del rol vigente', { ...asU, declaredType: 'ROTATION_PROPOSE', safeTx: propose(2, U, NEW_KEY), facts: { newKeyIsSignerKey: true } }, REJECT('ROTATION_INVALID'));
add('rotación: new es un owner actual', { ...asU, declaredType: 'ROTATION_PROPOSE', safeTx: propose(2, S, R), facts: { newKeyIsSignerKey: true } }, REJECT('ROTATION_INVALID'));
add('rotación: new es el sentinel', { ...asU, declaredType: 'ROTATION_PROPOSE', safeTx: propose(0, U, SENTINEL), facts: { keyAcceptanceValid: true } }, REJECT('ROTATION_INVALID'));
add('rotación: new es un contrato del sistema', { ...asU, declaredType: 'ROTATION_PROPOSE', safeTx: propose(0, U, C.walletFactory), facts: { keyAcceptanceValid: true } }, REJECT('ROTATION_INVALID'));
add('rotación: U propone GUARD hacia un sucesor registrado', { ...asU, declaredType: 'ROTATION_PROPOSE', safeTx: propose(3, C.securityGuard, NEW_GUARD), facts: { currentGuard: C.securityGuard, successorRegistered: true } }, ACCEPT);
add('rotación: GUARD hacia algo no registrado', { ...asU, declaredType: 'ROTATION_PROPOSE', safeTx: propose(3, C.securityGuard, NEW_GUARD), facts: { currentGuard: C.securityGuard, successorRegistered: false } }, REJECT('GUARD_UPGRADE_INVALID'));
add('rotación: MODULE_GUARD con old distinto del slot', { ...asU, declaredType: 'ROTATION_PROPOSE', safeTx: propose(4, NEW_GUARD, C.denyAllModuleGuard), facts: { currentModuleGuard: C.denyAllModuleGuard, successorRegistered: true } }, REJECT('ROTATION_INVALID'));

// --- ROTATION_EXECUTE -----------------------------------------------------------------------------------------
const execFacts = (o = {}) => ({ prevOwnerCorrect: true, rotationExecutable: true, ...o });
add('ejecución: S → clave del signer, madura', { ...asU, declaredType: 'ROTATION_EXECUTE', safeTx: swapOwner(R, S, NEW_KEY), facts: execFacts({ newKeyIsSignerKey: true }) }, ACCEPT);
add('ejecución: propuesta no madura', { ...asU, declaredType: 'ROTATION_EXECUTE', safeTx: swapOwner(R, S, NEW_KEY), facts: execFacts({ newKeyIsSignerKey: true, rotationExecutable: false }) }, REJECT('ROTATION_NOT_EXECUTABLE'));
add('ejecución: prev incorrecto', { ...asU, declaredType: 'ROTATION_EXECUTE', safeTx: swapOwner(SENTINEL, S, NEW_KEY), facts: execFacts({ newKeyIsSignerKey: true, prevOwnerCorrect: false }) }, REJECT('ROTATION_INVALID'));
add('ejecución: R ejecuta la rotación de R', { ...asR, declaredType: 'ROTATION_EXECUTE', safeTx: swapOwner(U, R, NEW_KEY), facts: execFacts({ keyAcceptanceValid: true }) }, REJECT('ROTATION_INVALID'));
add('ejecución: R ejecuta U → U\' (recovery)', { ...asR, declaredType: 'ROTATION_EXECUTE', safeTx: swapOwner(SENTINEL, U, NEW_KEY), facts: execFacts({ keyAcceptanceValid: true }) }, ACCEPT);
add('ejecución: U → U\' sin KeyAcceptance', { ...asR, declaredType: 'ROTATION_EXECUTE', safeTx: swapOwner(SENTINEL, U, NEW_KEY), facts: execFacts({ keyAcceptanceValid: false }) }, REJECT('KEY_ACCEPTANCE_REQUIRED'));
add('ejecución: old no es un rol vigente', { ...asU, declaredType: 'ROTATION_EXECUTE', safeTx: swapOwner(SENTINEL, DEST, NEW_KEY), facts: execFacts({ newKeyIsSignerKey: true }) }, REJECT('ROTATION_INVALID'));
add('ejecución: S hacia una clave ajena', { ...asU, declaredType: 'ROTATION_EXECUTE', safeTx: swapOwner(R, S, NEW_KEY), facts: execFacts({ newKeyIsSignerKey: false }) }, REJECT('ROTATION_TARGET_NOT_SIGNER_KEY'));

// --- GUARD_UPGRADE --------------------------------------------------------------------------------------------
add('guard: setGuard hacia el sucesor con propuesta madura', { ...asU, declaredType: 'GUARD_UPGRADE', safeTx: safeTx(SAFE, call('setGuard(address)', word(NEW_GUARD))), facts: { successorRegistered: true, guardUpgradeMature: true } }, ACCEPT);
add('guard: setModuleGuard hacia el sucesor con propuesta madura', { ...asU, declaredType: 'GUARD_UPGRADE', safeTx: safeTx(SAFE, call('setModuleGuard(address)', word(NEW_GUARD))), facts: { successorRegistered: true, guardUpgradeMature: true } }, ACCEPT);
add('guard: propuesta no madura', { ...asU, declaredType: 'GUARD_UPGRADE', safeTx: safeTx(SAFE, call('setGuard(address)', word(NEW_GUARD))), facts: { successorRegistered: true, guardUpgradeMature: false } }, REJECT('GUARD_UPGRADE_INVALID'));
add('guard: sucesor no registrado', { ...asU, declaredType: 'GUARD_UPGRADE', safeTx: safeTx(SAFE, call('setGuard(address)', word(NEW_GUARD))), facts: { successorRegistered: false, guardUpgradeMature: true } }, REJECT('GUARD_UPGRADE_INVALID'));
add('guard: firmado por R', { ...asR, declaredType: 'GUARD_UPGRADE', safeTx: safeTx(SAFE, call('setGuard(address)', word(NEW_GUARD))), facts: { successorRegistered: true, guardUpgradeMature: true } }, REJECT('OPERATION_NOT_ALLOWED'));

const vectors = {
  format:
    '[B-POL] veredictos de policy compartidos por backend y signer: decisión pura sobre la SafeTx, el rol, el scope, el tipo declarado y hechos ya leídos (montos en unidades de 6 decimales; now en segundos Unix)',
  rejectCodes: [...new Set(cases.filter((c) => c.expected.verdict === 'REJECT').map((c) => c.expected.code))].sort(),
  snapshot,
  cases,
};

const text = `${JSON.stringify(vectors, null, 2)}\n`;
if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
    console.error('policy-vectors: test/vectors/policy/policy.json desactualizado (node script/policy-vectors.mjs)');
    process.exit(1);
  }
  console.log(`policy-vectors OK (${cases.length} casos)`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`policy-vectors: ${cases.length} casos en test/vectors/policy/policy.json`);
}
