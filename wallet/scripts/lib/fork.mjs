#!/usr/bin/env node
// Operaciones sobre el fork local de Anvil (P00.T03). Lee wallet/.env con el parser propio.
// Uso: node scripts/lib/fork.mjs wait | reset
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readEnvFile } from '../preflight.d/lib/env.mjs';
import { rpc } from '../preflight.d/lib/net.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = { ...readEnvFile(resolve(process.env.MTW_ENV_FILE ?? join(ROOT, '.env'))) };
for (const k of ['BASE_RPC_URL', 'FORK_BLOCK_NUMBER', 'LOCAL_RPC_URL']) if (process.env[k]) env[k] = process.env[k];
const local = env.LOCAL_RPC_URL || 'http://127.0.0.1:8545';
const forkBlock = Number(env.FORK_BLOCK_NUMBER);

async function waitChain(timeoutMs = 300000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const { result } = await rpc(local, 'eth_chainId', [], 5000);
      if (result === '0x2105') return;
      throw new Error(`chainId ${result}`);
    } catch (e) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`el fork no respondió con chainId 0x2105 (${e.message})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function reset() {
  if (!env.BASE_RPC_URL) throw new Error('falta BASE_RPC_URL (docs/SETUP_EXTERNAL_SERVICES.md#base_rpc_url)');
  if (!Number.isInteger(forkBlock) || forkBlock <= 0) throw new Error('FORK_BLOCK_NUMBER inválido');
  await waitChain();
  // Se pausa el minado por intervalo para verificar el estado exacto del reset y luego se restaura.
  await rpc(local, 'evm_setIntervalMining', [0], 30000);
  await rpc(local, 'anvil_reset', [{ forking: { jsonRpcUrl: env.BASE_RPC_URL, blockNumber: forkBlock } }], 120000);
  const { result: info } = await rpc(local, 'anvil_nodeInfo', [], 30000);
  const { result: bn } = await rpc(local, 'eth_blockNumber', [], 30000);
  const ok = Number(info?.forkConfig?.forkBlockNumber) === forkBlock && Number(bn) === forkBlock;
  await rpc(local, 'evm_setIntervalMining', [2], 30000);
  if (!ok) throw new Error(`reset inconsistente: forkBlockNumber=${info?.forkConfig?.forkBlockNumber} eth_blockNumber=${Number(bn)} (esperado ${forkBlock})`);
  console.log(`fork reseteado al bloque ${forkBlock} (forkBlockNumber y eth_blockNumber verificados)`);
}

const cmd = process.argv[2];
try {
  if (cmd === 'wait') {
    await waitChain();
    console.log('fork listo (chainId 0x2105)');
  } else if (cmd === 'reset') await reset();
  else throw new Error('uso: fork.mjs wait | reset');
} catch (e) {
  console.error(`fork: ${e.message}`);
  process.exit(1);
}
