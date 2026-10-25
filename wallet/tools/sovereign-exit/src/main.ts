// Salida soberana de MT Wallet (P19.T09): la única pieza que junta U y R, sólo en la máquina del usuario y fuera de los
// origins de la plataforma. Corre como un archivo HTML local, sin servidores: habla sólo con el RPC que indica el
// usuario. Abre U y R (sobre cifrado + Password, o 17 palabras), lee la Safe, arma una SafeTx tipada con el nonce
// on-chain, la firma con U y R, combina las firmas y emite la calldata de execTransaction o la transmite con la cuenta
// que el usuario elija para pagar el gas.
import './styles.css';
import { getAddress, isAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { bytesToHex, hexToBytes, wipe } from './crypto/encoding.ts';
import { openEnvelope, parseEnvelope, type KeyRole } from './crypto/envelope.ts';
import { verifiedWordlist, wordsToKey, type Wordlist } from './crypto/words.ts';
import { noop, removeGuard, replaceOwner, transferAll, type Asset, type Typed } from './safe/actions.ts';
import { readSafe, transmit, type SafeState } from './safe/chain.ts';
import { execTransactionData, safeTxHash, signHash, type OwnerSignature } from './safe/safe-tx.ts';
import { el, field, notice, replace } from './dom.ts';
import wordlistText from './vendor/mtw-wordlist-v1.txt?raw';

interface OpenKey {
  address: Address;
  bytes: Uint8Array;
}

const keys = new Map<KeyRole, OpenKey>();
let rpcUrl = '';
let safe: SafeState | null = null;
let built: (Typed & { hash: Hex }) | null = null;
let calldata: Hex | null = null;
let wordlist: Promise<Wordlist> | null = null;

function words(): Promise<Wordlist> {
  wordlist ??= verifiedWordlist(wordlistText);
  return wordlist;
}

function parseAddress(text: string): Address {
  const value = text.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('Escribí una dirección de Base (0x y 40 caracteres).');
  const mixed = value !== value.toLowerCase() && value.slice(2) !== value.slice(2).toUpperCase();
  if (mixed && !isAddress(value, { strict: true })) {
    throw new Error('La dirección tiene un error de tipeo (el checksum EIP-55 no coincide).');
  }
  return getAddress(value.toLowerCase());
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Algo salió mal.';
}

/** Un botón que corre una acción asíncrona y muestra su error en `out`. */
function action(label: string, out: HTMLElement, run: () => Promise<void>): HTMLButtonElement {
  const button = el('button', { type: 'button' }, label);
  button.addEventListener('click', () => {
    button.disabled = true;
    replace(out, notice('info', 'Trabajando…'));
    run()
      .catch((error: unknown) => {
        replace(out, notice('error', message(error)));
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  return button;
}

function readFile(input: HTMLInputElement): Promise<string> {
  const file = input.files?.[0];
  if (!file) return Promise.reject(new Error('Elegí el archivo del sobre cifrado.'));
  return file.text();
}

// --- Red y Safe ---------------------------------------------------------------------------------------------------

const rpcInput = el('input', { name: 'rpc', type: 'url', autocomplete: 'off', placeholder: 'https://…' });
const safeInput = el('input', { name: 'safe', autocomplete: 'off', spellcheck: 'false' });
const safeOut = el('div', { 'data-out': 'safe' });

function renderSafe(state: SafeState): void {
  replace(
    safeOut,
    notice('ok', `Safe en Base · nonce ${state.nonce.toString()} · ${state.threshold.toString()} firmas requeridas`),
    el('p', { 'data-safe-nonce': state.nonce.toString() }, 'Owners:'),
    el('ul', {}, ...state.owners.map((o) => el('li', { class: 'mono' }, o))),
    el(
      'p',
      { class: 'muted' },
      `Saldos: ${state.balances.USDC.toString()} USDC (6 dec.) · ${state.balances.USDT.toString()} USDT (6 dec.) · ${state.balances.ETH.toString()} wei`,
    ),
  );
}

const readButton = action('Leer la Safe', safeOut, async () => {
  rpcUrl = rpcInput.value.trim();
  safe = await readSafe(rpcUrl, parseAddress(safeInput.value));
  renderSafe(safe);
});

// --- Claves U y R --------------------------------------------------------------------------------------------------

function keySection(role: KeyRole): HTMLElement {
  const out = el('div', { 'data-out': `key-${role}` });
  const source = el('select', { name: `source-${role}` });
  source.append(
    el('option', { value: 'envelope' }, `Sobre cifrado (${role}.enc) + Password ${role}`),
    el('option', { value: 'words' }, `Las 17 palabras de ${role}`),
  );
  const file = el('input', { name: `file-${role}`, type: 'file', accept: 'application/json,.json' });
  const password = el('input', { name: `password-${role}`, type: 'password', autocomplete: 'off' });
  const text = el('textarea', { name: `words-${role}`, rows: '3', autocomplete: 'off', spellcheck: 'false' });
  const envelopeFields = el(
    'div',
    {},
    field(`Archivo del sobre ${role}.enc`, file),
    field(`Password ${role}`, password),
  );
  const wordFields = el('div', { hidden: '' }, field(`17 palabras de ${role}`, text));
  source.addEventListener('change', () => {
    envelopeFields.hidden = source.value !== 'envelope';
    wordFields.hidden = source.value !== 'words';
  });
  const open = action(`Abrir ${role}`, out, async () => {
    let bytes: Uint8Array;
    if (source.value === 'envelope') {
      const envelope = parseEnvelope(JSON.parse(await readFile(file)));
      if (envelope.role !== role) throw new Error(`Ese sobre es de ${envelope.role}, no de ${role}.`);
      replace(out, notice('info', 'Derivando la clave del sobre (Argon2id, puede tardar)…'));
      bytes = await openEnvelope(envelope, password.value);
      password.value = '';
    } else {
      bytes = await wordsToKey(role, text.value, await words());
      text.value = '';
    }
    const address = privateKeyToAddress(bytesToHex(bytes));
    const previous = keys.get(role);
    if (previous) wipe(previous.bytes);
    keys.set(role, { address, bytes });
    const owner = safe?.owners.some((o) => isAddressEqual(o, address)) ?? false;
    replace(
      out,
      notice(
        owner ? 'ok' : 'info',
        `${role} abierta, dirección ${address}${safe === null ? '' : owner ? ' (owner de la Safe)' : ''}`,
      ),
      safe !== null && !owner ? notice('error', `${role} no es owner de esta Safe: su firma no sirve.`) : null,
    );
    out.dataset.address = address;
  });
  return el(
    'section',
    { 'aria-labelledby': `key-${role}-title` },
    el('h2', { id: `key-${role}-title` }, `Clave ${role}`),
    field('Desde', source),
    envelopeFields,
    wordFields,
    open,
    out,
  );
}

// --- Operación -----------------------------------------------------------------------------------------------------

const ACTIONS: { value: string; label: string }[] = [
  { value: 'TRANSFER_USDC', label: 'Transferir todo el USDC a una dirección' },
  { value: 'TRANSFER_USDT', label: 'Transferir todo el USDT a una dirección' },
  { value: 'TRANSFER_ETH', label: 'Transferir todo el ETH a una dirección' },
  { value: 'REPLACE_OWNER', label: 'Reemplazar una clave de la Safe (p. ej. la de la plataforma, S)' },
  { value: 'REMOVE_GUARD', label: 'Retirar el Guard de la Safe' },
  { value: 'REMOVE_MODULE_GUARD', label: 'Retirar el guard de módulos de la Safe' },
  { value: 'NOOP', label: 'Anular el nonce actual (NoOp)' },
];

const actionSelect = el('select', { name: 'action' });
actionSelect.append(...ACTIONS.map((a) => el('option', { value: a.value }, a.label)));
const destinationInput = el('input', { name: 'destination', autocomplete: 'off', spellcheck: 'false' });
const oldOwnerInput = el('input', { name: 'oldOwner', autocomplete: 'off', spellcheck: 'false' });
const newOwnerInput = el('input', { name: 'newOwner', autocomplete: 'off', spellcheck: 'false' });
const destinationField = field('Dirección de destino', destinationInput);
const replaceFields = el(
  'div',
  { hidden: '' },
  field('Dirección de la clave que sale', oldOwnerInput),
  field('Dirección de la clave nueva', newOwnerInput),
);
actionSelect.addEventListener('change', () => {
  destinationField.hidden = !actionSelect.value.startsWith('TRANSFER_');
  replaceFields.hidden = actionSelect.value !== 'REPLACE_OWNER';
});
const buildOut = el('div', { 'data-out': 'build' });

function typedAction(state: SafeState): Typed {
  const kind = actionSelect.value;
  if (kind.startsWith('TRANSFER_')) {
    const asset = kind.slice('TRANSFER_'.length) as Asset;
    return transferAll(state.safe, asset, parseAddress(destinationInput.value), state.balances[asset], state.nonce);
  }
  if (kind === 'REPLACE_OWNER') {
    return replaceOwner(
      state.safe,
      state.owners,
      parseAddress(oldOwnerInput.value),
      parseAddress(newOwnerInput.value),
      state.nonce,
    );
  }
  if (kind === 'REMOVE_GUARD' || kind === 'REMOVE_MODULE_GUARD') {
    return removeGuard(state.safe, kind === 'REMOVE_GUARD' ? 'GUARD' : 'MODULE_GUARD', state.nonce);
  }
  return noop(state.safe, state.nonce);
}

const buildButton = action('Armar la operación', buildOut, async () => {
  if (safe === null) throw new Error('Primero leé la Safe.');
  // Saldos y nonce de ahora: la operación usa el estado on-chain del momento.
  safe = await readSafe(rpcUrl, safe.safe);
  renderSafe(safe);
  const typed = typedAction(safe);
  built = { ...typed, hash: safeTxHash(8453, safe.safe, typed.tx) };
  calldata = null;
  replace(
    buildOut,
    el('p', { 'data-description': '' }, typed.description),
    el('p', { class: 'muted mono' }, `Nonce ${typed.tx.nonce.toString()} · SafeTx ${built.hash}`),
  );
});

// --- Firmar, combinar y transmitir --------------------------------------------------------------------------------

const signOut = el('div', { 'data-out': 'sign' });
const calldataBox = el('textarea', { name: 'calldata', rows: '4', readonly: '' });

const signButton = action('Firmar con U y R', signOut, async () => {
  const user = keys.get('U');
  const recovery = keys.get('R');
  if (!built || safe === null) throw new Error('Primero armá la operación.');
  if (!user || !recovery) throw new Error('Abrí U y R.');
  for (const [role, key] of [
    ['U', user],
    ['R', recovery],
  ] as const) {
    if (!safe.owners.some((o) => isAddressEqual(o, key.address))) throw new Error(`${role} no es owner de la Safe.`);
  }
  if (isAddressEqual(user.address, recovery.address)) throw new Error('U y R son la misma clave.');
  const signatures: OwnerSignature[] = [
    await signHash(built.hash, user.bytes, user.address),
    await signHash(built.hash, recovery.bytes, recovery.address),
  ];
  calldata = execTransactionData(built.tx, signatures);
  calldataBox.value = calldata;
  replace(
    signOut,
    notice('ok', `Firmada por U (${user.address}) y R (${recovery.address}).`),
    field('Calldata de execTransaction (a la Safe)', calldataBox),
  );
});

const downloadButton = el('button', { type: 'button' }, 'Descargar la calldata');
downloadButton.addEventListener('click', () => {
  if (calldata === null || safe === null || built === null) return;
  const body = `${JSON.stringify({ chainId: 8453, to: safe.safe, value: '0', data: calldata, safeTxHash: built.hash }, null, 2)}\n`;
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const link = el('a', { href: url, download: `mtw-exit-${built.hash.slice(2, 10)}.json` });
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1_000);
});

const payerSelect = el('select', { name: 'payer' });
payerSelect.append(
  el('option', { value: 'U' }, 'U'),
  el('option', { value: 'R' }, 'R'),
  el('option', { value: 'OTHER' }, 'Otra cuenta (clave privada)'),
);
const payerKeyInput = el('input', { name: 'payerKey', type: 'password', autocomplete: 'off' });
const payerKeyField = el('div', { hidden: '' }, field('Clave privada de la cuenta que paga el gas', payerKeyInput));
payerSelect.addEventListener('change', () => {
  payerKeyField.hidden = payerSelect.value !== 'OTHER';
});
const sendOut = el('div', { 'data-out': 'send' });

const sendButton = action('Transmitir', sendOut, async () => {
  if (calldata === null || safe === null) throw new Error('Primero firmá la operación.');
  let payer: Uint8Array;
  if (payerSelect.value === 'OTHER') payer = hexToBytes(payerKeyInput.value.trim(), 32);
  else {
    const key = keys.get(payerSelect.value as KeyRole);
    if (!key) throw new Error(`Abrí ${payerSelect.value} para pagar el gas con esa cuenta.`);
    payer = key.bytes.slice();
  }
  try {
    const result = await transmit(rpcUrl, payer, { to: safe.safe, data: calldata });
    if (result.status !== 'success')
      throw new Error(`La transacción ${result.hash} revirtió: la operación no se ejecutó.`);
    replace(sendOut, notice('ok', `Ejecutada en el bloque ${result.blockNumber.toString()} (tx ${result.hash}).`));
    sendOut.dataset.tx = result.hash;
  } finally {
    wipe(payer);
    payerKeyInput.value = '';
  }
});

const forget = el('button', { type: 'button' }, 'Borrar las claves de esta pestaña');
forget.addEventListener('click', () => {
  for (const key of keys.values()) wipe(key.bytes);
  keys.clear();
  built = null;
  calldata = null;
  calldataBox.value = '';
});
window.addEventListener('pagehide', () => {
  for (const key of keys.values()) wipe(key.bytes);
});

const app = document.getElementById('app');
if (app === null) throw new Error('falta #app');
replace(
  app,
  el(
    'section',
    { 'aria-labelledby': 'title' },
    el('h1', { id: 'title' }, 'Salida soberana de MT Wallet (U + R)'),
    el(
      'p',
      {},
      'Con tu clave U y tu clave R operás tu Safe sin la plataforma. Esta página corre sólo en tu navegador, sin servidores: habla únicamente con el RPC de Base que indiques. Las claves quedan en memoria de esta pestaña y se borran al cerrarla.',
    ),
  ),
  el(
    'section',
    { 'aria-labelledby': 'safe-title' },
    el('h2', { id: 'safe-title' }, 'Red y Safe'),
    field('RPC de Base', rpcInput),
    field('Dirección de tu Safe', safeInput),
    readButton,
    safeOut,
  ),
  keySection('U'),
  keySection('R'),
  el(
    'section',
    { 'aria-labelledby': 'action-title' },
    el('h2', { id: 'action-title' }, 'Operación'),
    field('Acción', actionSelect),
    destinationField,
    replaceFields,
    buildButton,
    buildOut,
  ),
  el(
    'section',
    { 'aria-labelledby': 'sign-title' },
    el('h2', { id: 'sign-title' }, 'Firmar y transmitir'),
    signButton,
    signOut,
    downloadButton,
    field('Paga el gas', payerSelect),
    payerKeyField,
    sendButton,
    sendOut,
    forget,
  ),
);
