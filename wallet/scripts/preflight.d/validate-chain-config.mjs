#!/usr/bin/env node
// Valida config/chains/base-mainnet.json contra config/chains/schema.json y reglas extra:
// direcciones con checksum EIP-55 y tokens del pool coherentes. Uso: node scripts/preflight.d/validate-chain-config.mjs [archivo]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { validate } from './lib/jsonschema.mjs';
import { isChecksumAddress } from './lib/keccak.mjs';

const WALLET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function validateChainConfig(configPath = join(WALLET_ROOT, 'config/chains/base-mainnet.json')) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const schema = JSON.parse(readFileSync(join(WALLET_ROOT, 'config/chains/schema.json'), 'utf8'));
  const errors = validate(schema, config);
  for (const [name, c] of Object.entries(config.contracts ?? {})) {
    for (const key of ['address', 'token0', 'token1']) {
      if (c[key] && !isChecksumAddress(c[key])) errors.push(`contracts.${name}.${key}: checksum EIP-55 inválido`);
    }
    if (c.implementation?.address && !isChecksumAddress(c.implementation.address)) errors.push(`contracts.${name}.implementation.address: checksum EIP-55 inválido`);
  }
  const pool = config.contracts?.uniswapV3PoolUsdcUsdt100;
  if (pool && (pool.token0 !== config.contracts.usdc?.address || pool.token1 !== config.contracts.usdt?.address)) {
    errors.push('contracts.uniswapV3PoolUsdcUsdt100: token0/token1 deben ser USDC/USDT');
  }
  return { config, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { errors } = validateChainConfig(process.argv[2]);
  if (errors.length) {
    for (const e of errors) console.error(`ERROR ${e}`);
    process.exit(1);
  }
  console.log('config de cadena válida');
}
