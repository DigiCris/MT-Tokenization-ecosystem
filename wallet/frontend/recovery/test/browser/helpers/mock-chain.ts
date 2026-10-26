// Base simulada para los specs de navegador sin stack (verificación de P17.MAN, N15): el RPC del build responde una Safe
// del sistema con los roles que pide el test, para que RecoveryGate la verifique como la verifica contra el fork (código
// de cada contrato, slots de la Safe, threshold, owners, registro y roles del Guard, propuestas del timelock). Sin el
// fork no existe el código real de los contratos, así que cada uno devuelve un código de prueba (los bytes de su
// codehash fijado) y la app ve como fijado el keccak de ese código: el test reemplaza cada codehash fijado (contratos
// del sistema del deployment del build y la Safe v1.5.0 de src/config/chain.base.json) en los JS que sirve
// `vite preview` y recalcula el SRI de index.html para esos JS. Nada más del bundle cambia.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrowserContext } from '@playwright/test';
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  isAddressEqual,
  keccak256,
  padHex,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import { systemContractsOf } from '../../../build/system-contracts.ts';
import { iSafeAbi } from '../../../src/chain/abis/ISafe.ts';
import { rotationTimelockAbi } from '../../../src/chain/abis/RotationTimelock.ts';
import { securityGuardAbi } from '../../../src/chain/abis/SecurityGuard.ts';
import { SAFE_SLOTS } from '../../../src/chain/safe-check.ts';
import { buildConfig } from './mock-api.ts';

/** La Safe que ve la app: su dirección y sus roles (owners = los tres roles, salvo que se pida otra cosa). */
export interface MockSafe {
  safe: Address;
  roles: { userKey: Address; recoveryKey: Address; executor: Address };
}

interface PinnedCode {
  address: Address;
  /** El codehash fijado en el build. */
  pinned: Hex;
}

/** Lo fijado en el build: los contratos del sistema (del deployment) y el SafeL2 y el proxy de Safe v1.5.0. */
function pinnedCodes(): { system: Record<string, PinnedCode>; singleton: PinnedCode; proxy: Hex } {
  const file = systemContractsOf(buildConfig);
  const chain = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../../src/config/chain.base.json'), 'utf8'),
  ) as {
    contracts: {
      safeL2Singleton: { address: string; codehash: Hex };
      safeProxyFactory: { proxyRuntimeCodehash: Hex };
    };
  };
  const system = Object.fromEntries(
    Object.entries(file.contracts).map(([role, c]) => [
      role,
      { address: getAddress(c.address), pinned: c.codehash as Hex },
    ]),
  );
  return {
    system,
    singleton: {
      address: getAddress(chain.contracts.safeL2Singleton.address),
      pinned: chain.contracts.safeL2Singleton.codehash,
    },
    proxy: chain.contracts.safeProxyFactory.proxyRuntimeCodehash,
  };
}

/** El código de prueba de un contrato (los bytes de su codehash fijado) y el codehash que la app ve como fijado. */
const testCode = (pinned: Hex): { code: Hex; hash: Hex } => ({ code: pinned, hash: keccak256(pinned) });

/** El contrato del sistema por rol (guard, timelock, moduleGuard…), como lo fija el build. */
export function systemAddress(role: string): Address {
  const entry = pinnedCodes().system[role];
  if (entry === undefined) throw new Error(`contrato del sistema desconocido: ${role}`);
  return entry.address;
}

/**
 * En `context`, la app de `origin` con los codehash de prueba en el bundle y el RPC del build respondiendo `chain`: la
 * Safe (proxy de Safe v1.5.0 con el SafeL2, el Guard y el module guard del sistema, registrada, threshold 2), los roles
 * del Guard y ninguna propuesta en el timelock. Cualquier otra dirección no tiene código.
 */
export async function mockChain(context: BrowserContext, origin: string, chain: MockSafe): Promise<void> {
  const { system, singleton, proxy } = pinnedCodes();
  const codes = new Map<string, Hex>();
  const rewrite = new Map<string, Hex>();
  const pin = (address: Address, pinned: Hex) => {
    const { code, hash } = testCode(pinned);
    codes.set(address.toLowerCase(), code);
    rewrite.set(pinned, hash);
  };
  for (const entry of Object.values(system)) pin(entry.address, entry.pinned);
  pin(singleton.address, singleton.pinned);
  pin(chain.safe, proxy);
  const guard = systemAddress('guard');
  const timelock = systemAddress('timelock');
  const moduleGuard = systemAddress('moduleGuard');
  const owners = [chain.roles.userKey, chain.roles.recoveryKey, chain.roles.executor];

  const patch = (text: string): string => {
    let out = text;
    for (const [from, to] of rewrite) out = out.replaceAll(from, to);
    return out;
  };
  const integrity = (text: string) => `sha384-${createHash('sha384').update(patch(text)).digest('base64')}`;
  // Los JS del bundle, con los codehash de prueba.
  await context.route(
    (url) => url.origin === origin && url.pathname.startsWith('/assets/') && url.pathname.endsWith('.js'),
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: patch(await response.text()) });
    },
  );
  // index.html con el SRI de esos JS.
  await context.route(
    (url) => url.origin === origin && !url.pathname.startsWith('/assets/'),
    async (route) => {
      if (route.request().resourceType() !== 'document') {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      let html = await response.text();
      for (const [, path = '', sri = ''] of html.matchAll(
        /(?:src|href)="(\/assets\/[^"]+\.js)" integrity="([^"]+)"/g,
      )) {
        const asset = await fetch(`${origin}${path}`);
        html = html.replace(sri, integrity(await asset.text()));
      }
      await route.fulfill({ response, body: html });
    },
  );

  const isSafe = (address: string) => isAddressEqual(address as Address, chain.safe);
  const storage = (address: string, slot: string): Hex => {
    if (!isSafe(address)) return zeroHash;
    const at = BigInt(slot);
    if (at === BigInt(SAFE_SLOTS.singleton)) return padHex(singleton.address, { size: 32 });
    if (at === BigInt(SAFE_SLOTS.guard)) return padHex(guard, { size: 32 });
    if (at === BigInt(SAFE_SLOTS.moduleGuard)) return padHex(moduleGuard, { size: 32 });
    return zeroHash;
  };
  /** eth_call a la Safe, al Guard o al timelock (lo que lee la verificación); otra llamada revierte. */
  const call = (to: string, data: Hex): Hex | null => {
    if (isSafe(to)) {
      const { functionName } = decodeFunctionData({ abi: iSafeAbi, data });
      if (functionName === 'getThreshold') return encodeFunctionResult({ abi: iSafeAbi, functionName, result: 2n });
      if (functionName === 'getOwners') return encodeFunctionResult({ abi: iSafeAbi, functionName, result: owners });
      if (functionName === 'nonce') return encodeFunctionResult({ abi: iSafeAbi, functionName, result: 0n });
      return null;
    }
    if (isAddressEqual(to as Address, guard)) {
      const decoded = decodeFunctionData({ abi: securityGuardAbi, data });
      if (decoded.functionName === 'isRegistered') {
        const [safe] = decoded.args;
        return encodeFunctionResult({ abi: securityGuardAbi, functionName: 'isRegistered', result: isSafe(safe) });
      }
      if (decoded.functionName === 'rolesOf') {
        return encodeFunctionResult({
          abi: securityGuardAbi,
          functionName: 'rolesOf',
          result: { ...chain.roles, initialized: true, version: 1n },
        });
      }
      return null;
    }
    if (isAddressEqual(to as Address, timelock)) {
      const { functionName } = decodeFunctionData({ abi: rotationTimelockAbi, data });
      if (functionName === 'activeProposal') {
        return encodeFunctionResult({ abi: rotationTimelockAbi, functionName, result: zeroHash });
      }
      return null;
    }
    return null;
  };
  type RpcRequest = { id: number; method: string; params: unknown[] };
  const answer = (request: RpcRequest) => {
    const { id, method, params } = request;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    const reverted = { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted' } };
    switch (method) {
      case 'eth_chainId':
        return ok('0x2105');
      case 'eth_getCode':
        return ok(codes.get(String(params[0]).toLowerCase()) ?? '0x');
      case 'eth_getStorageAt':
        return ok(storage(String(params[0]), String(params[1])));
      case 'eth_call': {
        const { to, data } = params[0] as { to: string; data: Hex };
        try {
          const result = call(to, data);
          return result === null ? reverted : ok(result);
        } catch {
          // Una función que no está en el ABI de ese contrato.
          return reverted;
        }
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `método no simulado: ${method}` } };
    }
  };
  const rpc = new URL(buildConfig.rpcUrl);
  await context.route(
    (url) => url.origin === rpc.origin,
    async (route) => {
      const request = route.request();
      const cors = {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': (await request.headerValue('access-control-request-headers')) ?? '',
      };
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      const body = request.postDataJSON() as RpcRequest | RpcRequest[];
      await route.fulfill({
        status: 200,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)),
      });
    },
  );
}
