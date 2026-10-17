import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, toHex, toChecksumAddress, isChecksumAddress, codehash } from '../lib/keccak.mjs';
import { parseEnv, updateEnvFile, splitValue } from '../lib/env.mjs';
import { validate } from '../lib/jsonschema.mjs';
import { render, pass, fail } from '../lib/report.mjs';
import { validateChainConfig } from '../validate-chain-config.mjs';
import { tmp } from './helpers.mjs';

test('keccak256: vectores conocidos', () => {
  assert.equal(toHex(keccak256(new Uint8Array())), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(toHex(keccak256(Buffer.from('abc'))), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(toHex(keccak256(Buffer.from('The quick brown fox jumps over the lazy dog'))), '0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15');
  assert.equal(toHex(keccak256(Buffer.from('org.zeppelinos.proxy.implementation'))), '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3');
  // Multi-bloque (> 136 bytes): 200 bytes 0x61; referencia de `cast keccak`.
  assert.equal(codehash('0x' + '61'.repeat(200)), MULTIBLOCK_REF);
});

test('EIP-55: checksum de direcciones', () => {
  assert.equal(toChecksumAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(isChecksumAddress('0xEdd160fEBBD92E350D4D398fb636302fccd67C7e'), true);
  assert.equal(isChecksumAddress('0xedd160febbd92e350d4d398fb636302fccd67c7e'), false);
});

test('parser .env: comillas, comentarios en línea y valores vacíos', () => {
  const env = parseEnv(["A=1 # comentario", "B='con # numeral'", 'C="doble"  # x', 'D=', "E='[{\"id\":\"x\"}]'", '# Z=no', 'export F=f', 'G=          # [GEN local] sólo comentario', 'H=#literal'].join('\n'));
  assert.deepEqual(env, { A: '1', B: 'con # numeral', C: 'doble', D: '', E: '[{"id":"x"}]', F: 'f', G: '', H: '#literal' });
  assert.deepEqual(splitValue(' v   # c'), { value: 'v', quoted: '', rest: '   # c' });
});

test('updateEnvFile preserva comentarios y sólo cambia las claves pedidas', () => {
  const f = join(tmp(), '.env');
  writeFileSync(f, '# cabecera\nA=          # comentario A\nB=keep\n');
  updateEnvFile(f, { A: 'nuevo', C: 'agregado' });
  const text = readFileSync(f, 'utf8');
  assert.match(text, /^# cabecera$/m);
  assert.match(text, /^A=nuevo\s+# comentario A$/m);
  assert.match(text, /^B=keep$/m);
  assert.match(text, /^C=agregado$/m);
  assert.deepEqual(parseEnv(text), { A: 'nuevo', B: 'keep', C: 'agregado' });
});

test('config de cadena: válida y con checksums EIP-55', () => {
  const { errors } = validateChainConfig();
  assert.deepEqual(errors, []);
  assert.deepEqual(validate({ type: 'object', required: ['x'] }, {}), ['$: falta "x"']);
});

test('render: todo correcto → última línea exactamente PREFLIGHT PASSED', () => {
  const out = render([{ id: 'PF-01', title: 'x', ...pass('ok') }, { id: 'PF-33', title: 'resumen', ...pass('') }]);
  assert.equal(out.trim().split('\n').at(-1), 'PREFLIGHT PASSED');
});

test('render: con FAIL → STOP con qué falta, variable, cómo y documento', () => {
  const out = render([{ id: 'PF-11', title: 'vars', ...fail('BASE_RPC_URL ausente', { variable: 'BASE_RPC_URL', how: 'cargarla', anchor: 'base_rpc_url' }) }]);
  assert.match(out, /STOP: 1 check/);
  assert.match(out, /variable:\s+BASE_RPC_URL/);
  assert.match(out, /cómo obtenerla:\s+cargarla/);
  assert.match(out, /documento:\s+docs\/SETUP_EXTERNAL_SERVICES\.md#base_rpc_url/);
  assert.doesNotMatch(out, /PREFLIGHT PASSED/);
});

const MULTIBLOCK_REF = '0x96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d';
