// `/sovereign` (P19.T06, [F-LNK-03]): el modo soberano de Recovery, sin la plataforma (funciona con el backend apagado:
// ninguna llamada a la API). Se lee la Safe por el RPC propio, se elige una acción tipada, la app arma la SafeTx con el
// nonce on-chain y R firma el hash que calcula la app; el documento [W-05] se exporta (archivo o QR animado) para que U
// lo co-firme en la app Wallet y vuelve con la firma de U (archivo o QR). Con las firmas de U y R de owners vigentes se
// transmite `execTransaction` con una wallet externa (paga el gas) o se exporta la calldata para cualquier relayer.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Hex } from 'viem';
import { pinned, reader } from '../app/services.ts';
import { parseAddressInput } from '../chain/address.ts';
import { safeFailureText } from '../chain/safe-check.ts';
import { ConnectExternal } from '../enroll/ConnectExternal.tsx';
import type { ExternalSession } from '../external-wallet/types.ts';
import { decodeSafeTx } from '../operations/decode.ts';
import { encodeFrames, FrameCollector, type FrameProgress } from '../qr/frames.ts';
import { useSensitiveScreen, useSession, useSessionStore } from '../session/context.tsx';
import { currentSigner } from '../session/store.ts';
import { rememberedSafe } from '../storage/envelope-cache.ts';
import { AddressText } from '../ui/AddressText.tsx';
import { downloadText, readTextFile } from '../ui/download.ts';
import { describeError } from '../ui/errors.ts';
import { Field, formValue, Notice, SelectField, useAsyncAction } from '../ui/forms.tsx';
import { QrFrames } from '../ui/QrCanvas.tsx';
import { QrScanner } from '../ui/QrScanner.tsx';
import { UnlockRecovery } from '../unlock/UnlockRecovery.tsx';
import {
  mergeSignatures,
  parseSovereignDocument,
  sovereignContent,
  sovereignFile,
  sovereignFileName,
  toSafeTx,
  verifySignatures,
  type SovereignDocument,
} from './document.ts';
import {
  buildActions,
  calldataFile,
  documentsFor,
  executionReadiness,
  isOwner,
  readSovereignSafe,
  signWithRecovery,
  type ActionInput,
  type Readiness,
  type SovereignSafe,
} from './flow.ts';

const ACTIONS: { value: ActionInput['type']; label: string }[] = [
  { value: 'TRANSFER', label: 'Transferir todo el saldo de un token a una dirección' },
  { value: 'EXECUTOR_REPLACEMENT', label: 'Reemplazar la clave de la plataforma (S)' },
  { value: 'SET_GUARD', label: 'Cambiar o retirar el Guard de seguridad' },
  { value: 'SET_MODULE_GUARD', label: 'Cambiar o retirar el guard de módulos' },
  { value: 'UPDATE_ROLES', label: 'Actualizar los roles del Guard' },
  { value: 'NOOP', label: 'Anular una operación pendiente (NoOp)' },
];

function decodedText(doc: SovereignDocument): { known: boolean; text: string } {
  return decodeSafeTx(toSafeTx(doc), { safe: doc.safe, chain: pinned.chain, system: pinned.system });
}

function actionInput(form: HTMLFormElement, type: ActionInput['type']): ActionInput {
  const value = (name: string) => formValue(form, name).trim();
  switch (type) {
    case 'TRANSFER':
      return { type, token: value('token') === 'USDT' ? 'USDT' : 'USDC', destination: value('destination') };
    case 'EXECUTOR_REPLACEMENT':
      return { type, newExecutor: value('newExecutor') };
    case 'SET_GUARD':
    case 'SET_MODULE_GUARD':
      return { type, guard: value('guard'), remove: value('guardMode') === 'remove' };
    case 'UPDATE_ROLES':
      return { type, userKey: value('userKey'), recoveryKey: value('recoveryKey'), executor: value('executor') };
    case 'NOOP':
      return { type, nonce: value('nonce') };
  }
}

function ActionFields({ type, state }: { type: ActionInput['type']; state: SovereignSafe }) {
  const [guardMode, setGuardMode] = useState<'remove' | 'replace'>('remove');
  if (type === 'TRANSFER') {
    return (
      <>
        <SelectField label="Token" name="token" defaultValue="USDC">
          <option value="USDC">USDC</option>
          <option value="USDT">USDT</option>
        </SelectField>
        <Field label="Dirección de destino en Base" name="destination" autoComplete="off" spellCheck={false} required />
        <p className="muted">
          Se transfiere todo el saldo del token que tenga la Safe (leído de la cadena al armarla).
        </p>
      </>
    );
  }
  if (type === 'EXECUTOR_REPLACEMENT') {
    return (
      <>
        {state.roles && (
          <p>
            S actual: <AddressText address={state.roles.executor} />
          </p>
        )}
        <Field label="Nueva clave S′" name="newExecutor" autoComplete="off" spellCheck={false} required />
        <p className="muted">
          Son dos operaciones en orden: reemplazar el owner en la Safe y actualizar los roles del Guard.
        </p>
      </>
    );
  }
  if (type === 'SET_GUARD' || type === 'SET_MODULE_GUARD') {
    return (
      <>
        <fieldset className="stack">
          <legend>Qué hacer</legend>
          <label className="check">
            <input
              type="radio"
              name="guardMode"
              value="remove"
              checked={guardMode === 'remove'}
              onChange={() => {
                setGuardMode('remove');
              }}
            />{' '}
            Retirarlo (la Safe queda sin {type === 'SET_GUARD' ? 'Guard' : 'guard de módulos'})
          </label>
          <label className="check">
            <input
              type="radio"
              name="guardMode"
              value="replace"
              checked={guardMode === 'replace'}
              onChange={() => {
                setGuardMode('replace');
              }}
            />{' '}
            Reemplazarlo por otro contrato
          </label>
        </fieldset>
        {guardMode === 'replace' && (
          <Field label="Dirección del nuevo contrato" name="guard" autoComplete="off" spellCheck={false} required />
        )}
      </>
    );
  }
  if (type === 'UPDATE_ROLES') {
    return (
      <>
        <Field
          label="Clave de usuario (U)"
          name="userKey"
          autoComplete="off"
          spellCheck={false}
          defaultValue={state.roles?.userKey ?? ''}
          required
        />
        <Field
          label="Clave de recuperación (R)"
          name="recoveryKey"
          autoComplete="off"
          spellCheck={false}
          defaultValue={state.roles?.recoveryKey ?? ''}
          required
        />
        <Field
          label="Clave de la plataforma (S)"
          name="executor"
          autoComplete="off"
          spellCheck={false}
          defaultValue={state.roles?.executor ?? ''}
          required
        />
      </>
    );
  }
  return (
    <Field
      label="Nonce de la operación a anular"
      name="nonce"
      inputMode="numeric"
      autoComplete="off"
      defaultValue={state.nonce.toString()}
      required
    />
  );
}

function DocumentCard({
  doc,
  readiness,
  payer,
  onExecuted,
}: {
  doc: SovereignDocument;
  readiness: Readiness | undefined;
  payer: ExternalSession | null;
  onExecuted: () => void;
}) {
  const [frames, setFrames] = useState<string[] | null>(null);
  const [executed, setExecuted] = useState<string | null>(null);
  const decoded = decodedText(doc);
  const roles = doc.signatures.map((s) => s.role).sort();

  const showQr = useAsyncAction(
    useCallback(async () => {
      setFrames(await encodeFrames(sovereignContent(doc)));
    }, [doc]),
  );

  const transmit = useAsyncAction(
    useCallback(
      async (data: Hex) => {
        if (!payer) return;
        const hash = await payer.sendTransaction({ to: doc.safe, data });
        const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
        if (receipt.status !== 'success')
          throw new Error(`La transacción ${hash} revirtió: la operación no se ejecutó.`);
        setExecuted(`Ejecutada en el bloque ${receipt.blockNumber.toString()} (tx ${hash.slice(0, 10)}…).`);
        onExecuted();
      },
      [payer, doc.safe, onExecuted],
    ),
  );

  return (
    <li className="card stack" data-sovereign-doc={doc.safeTxHash} data-roles={roles.join('')}>
      <p className="review__what">{decoded.text}</p>
      <p className="muted">
        Nonce {doc.safeTx.nonce} · hash <code>{doc.safeTxHash.slice(0, 18)}…</code> · firmas:{' '}
        {roles.length === 0 ? 'ninguna' : roles.join(' y ')}
      </p>
      <div className="actions">
        <button
          type="button"
          className="button button--secondary"
          onClick={() => {
            downloadText(sovereignFileName(doc), sovereignFile(doc));
          }}
        >
          Descargar el documento
        </button>
        {frames === null && (
          <button type="button" className="button button--secondary" onClick={() => void showQr.run()}>
            Mostrar el QR del documento
          </button>
        )}
      </div>
      {frames && <QrFrames frames={frames} label="QR del documento soberano" />}
      {executed ? (
        <Notice tone="success">{executed}</Notice>
      ) : readiness === undefined ? (
        <p className="muted">Verificando las firmas…</p>
      ) : readiness.ready ? (
        <div className="stack">
          <Notice tone="success">Tiene las firmas de U y R: se puede ejecutar.</Notice>
          <div className="actions">
            {payer && (
              <button
                type="button"
                className="button"
                disabled={transmit.pending}
                onClick={() => void transmit.run(readiness.data)}
              >
                {transmit.pending ? 'Transmitiendo…' : `Transmitir con ${payer.connectorName}`}
              </button>
            )}
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                downloadText(`mtw-exec-${doc.safeTxHash.slice(2, 10)}.json`, calldataFile(doc, readiness.data));
              }}
            >
              Exportar la calldata para un relayer
            </button>
          </div>
          {transmit.error && <Notice tone="error">{transmit.error}</Notice>}
        </div>
      ) : (
        <Notice tone="warning">{readiness.reason}</Notice>
      )}
      {showQr.error && <Notice tone="error">{showQr.error}</Notice>}
    </li>
  );
}

export function SovereignPage() {
  useSensitiveScreen();
  const session = useSession();
  const store = useSessionStore();
  const { recovery, external } = session;
  const signer = useMemo(() => currentSigner({ recovery, external }), [recovery, external]);
  const [mode, setMode] = useState<'internal' | 'external'>('internal');
  const [safeText, setSafeText] = useState('');
  const [state, setState] = useState<SovereignSafe | null>(null);
  const [type, setType] = useState<ActionInput['type']>('TRANSFER');
  const [drafts, setDrafts] = useState<SovereignDocument[] | null>(null);
  const [docs, setDocs] = useState<SovereignDocument[]>([]);
  const [readiness, setReadiness] = useState<Record<string, Readiness>>({});
  const [scanning, setScanning] = useState<FrameCollector | null>(null);
  const [progress, setProgress] = useState<FrameProgress | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [gasPayer, setGasPayer] = useState<ExternalSession | null>(null);
  const [connectPayer, setConnectPayer] = useState(false);
  const payer = external ?? gasPayer;

  // La Safe que esta R ya verificó en este dispositivo (sin preguntarle al backend).
  useEffect(() => {
    if (signer === null || safeText !== '') return;
    let alive = true;
    rememberedSafe(signer.address)
      .then((safe) => {
        if (alive && safe !== null) setSafeText((current) => (current === '' ? safe : current));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [signer, safeText]);

  useEffect(
    () => () => {
      void gasPayer?.disconnect();
    },
    [gasPayer],
  );

  const readSafe = useAsyncAction(
    useCallback(async (text: string) => {
      setState(await readSovereignSafe(reader, pinned, parseAddressInput(text)));
    }, []),
  );

  const refreshSafe = useCallback(() => {
    if (state) void readSafe.run(state.safe);
  }, [state, readSafe]);

  useEffect(() => {
    if (state === null) return;
    let alive = true;
    void Promise.all(
      docs.map(async (doc) => {
        const result: Readiness = await executionReadiness(doc, state).catch((error: unknown) => ({
          ready: false as const,
          reason: describeError(error),
        }));
        return [doc.safeTxHash, result] as const;
      }),
    ).then((entries) => {
      if (alive) setReadiness(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
  }, [docs, state]);

  const build = useAsyncAction(
    useCallback(
      async (input: ActionInput) => {
        if (!state) return;
        const actions = await buildActions(reader, pinned, state, input);
        setDrafts(documentsFor(state.safe, actions, new Date()));
      },
      [state],
    ),
  );

  const sign = useAsyncAction(
    useCallback(async () => {
      if (!drafts || !signer || !state) return;
      if (!isOwner(state, signer.address)) throw new Error('Tu clave R no es owner de esta Safe: no firma.');
      const signed: SovereignDocument[] = [];
      for (const doc of drafts) signed.push(await signWithRecovery(doc, signer));
      setDocs((current) => [...current.filter((d) => !signed.some((s) => s.safeTxHash === d.safeTxHash)), ...signed]);
      setDrafts(null);
    }, [drafts, signer, state]),
  );

  const importDocument = useCallback(
    async (text: string) => {
      try {
        setImportError(null);
        const imported = parseSovereignDocument(JSON.parse(text));
        await verifySignatures(imported);
        if (state !== null && imported.safe !== state.safe) {
          throw new Error('El documento es de otra Safe que la que estás usando.');
        }
        const existing = docs.find((d) => d.safeTxHash === imported.safeTxHash);
        const merged = existing ? await mergeSignatures(existing, imported) : imported;
        setDocs((current) => [...current.filter((d) => d.safeTxHash !== merged.safeTxHash), merged]);
        if (state === null) {
          setSafeText(merged.safe);
          await readSafe.run(merged.safe);
        }
      } catch (error) {
        setImportError(describeError(error));
      }
    },
    [docs, state, readSafe],
  );

  const onQrText = useCallback(
    (text: string) => {
      if (!scanning) return;
      const step = scanning.add(text);
      if (step) setProgress(step);
      void scanning
        .content()
        .then((content) => {
          if (content === null) return;
          setScanning(null);
          setProgress(null);
          void importDocument(content);
        })
        .catch((error: unknown) => {
          setImportError(describeError(error));
        });
    },
    [scanning, importDocument],
  );

  const sorted = [...docs].sort((a, b) => (BigInt(a.safeTx.nonce) < BigInt(b.safeTx.nonce) ? -1 : 1));
  const recoveryIsOwner = state !== null && signer !== null && isOwner(state, signer.address);

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="sovereign-title">
        <h1 id="sovereign-title">Modo soberano</h1>
        <p>
          Con tu clave R y tu clave U operás tu Safe sin la plataforma: esta app arma la operación con datos leídos de
          Base, R la firma acá, U la firma en la app Wallet y cualquiera puede transmitirla.
        </p>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void readSafe.run(formValue(event.currentTarget, 'safe'));
          }}
        >
          <Field
            label="Dirección de tu Safe"
            name="safe"
            autoComplete="off"
            spellCheck={false}
            required
            value={safeText}
            onChange={(event) => {
              setSafeText(event.currentTarget.value);
            }}
          />
          <button type="submit" className="button button--secondary" disabled={readSafe.pending}>
            {readSafe.pending ? 'Leyendo la Safe en Base…' : 'Leer la Safe en Base'}
          </button>
        </form>
        {readSafe.error && <Notice tone="error">{readSafe.error}</Notice>}
        {state && (
          <div className="stack" data-sovereign-safe={state.safe} data-nonce={state.nonce.toString()}>
            <p>
              Safe <AddressText address={state.safe} /> · nonce {state.nonce.toString()}
            </p>
            <p>Owners:</p>
            <ul className="list">
              {state.owners.map((owner) => (
                <li key={owner}>
                  <AddressText address={owner} />
                </li>
              ))}
            </ul>
            {state.warnings.length > 0 && (
              <Notice tone="warning">
                La Safe no está en la configuración asistida de la plataforma (en modo soberano puede ser lo esperado):
                <ul>
                  {state.warnings.map((item) => (
                    <li key={item}>{safeFailureText(item)}</li>
                  ))}
                </ul>
              </Notice>
            )}
          </div>
        )}
      </section>

      <section className="card stack" aria-labelledby="sov-key-title">
        <h2 id="sov-key-title">Tu clave R</h2>
        {signer === null ? (
          <>
            <div className="actions">
              <button
                type="button"
                className="button button--secondary"
                aria-pressed={mode === 'internal'}
                onClick={() => {
                  setMode('internal');
                }}
              >
                Mi clave R está en este navegador, un archivo o un QR
              </button>
              <button
                type="button"
                className="button button--secondary"
                aria-pressed={mode === 'external'}
                onClick={() => {
                  setMode('external');
                }}
              >
                Mi clave R es una wallet externa
              </button>
            </div>
            {mode === 'internal' ? (
              <UnlockRecovery allowCamera />
            ) : (
              <ConnectExternal
                onConnected={(session) => {
                  store.connectExternal(session);
                }}
              />
            )}
          </>
        ) : (
          <>
            <p>
              Clave R: <AddressText address={signer.address} />
            </p>
            {state !== null && !recoveryIsOwner && (
              <Notice tone="error">Esta clave R no es owner de la Safe: no puede firmar sus operaciones.</Notice>
            )}
          </>
        )}
      </section>

      {state && signer && recoveryIsOwner && (
        <section className="card stack" aria-labelledby="sov-action-title">
          <h2 id="sov-action-title">Nueva operación</h2>
          {drafts === null ? (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void build.run(actionInput(event.currentTarget, type));
              }}
            >
              <SelectField
                label="Acción"
                name="action"
                value={type}
                onChange={(event) => {
                  setType(event.currentTarget.value as ActionInput['type']);
                }}
              >
                {ACTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </SelectField>
              <ActionFields key={type} type={type} state={state} />
              {build.error && <Notice tone="error">{build.error}</Notice>}
              <button type="submit" className="button" disabled={build.pending}>
                Armar la operación
              </button>
            </form>
          ) : (
            <div className="stack">
              <ol className="review">
                {drafts.map((doc) => {
                  const decoded = decodedText(doc);
                  return (
                    <li key={doc.safeTxHash} className="review__item" data-draft={doc.action.type}>
                      <p className="review__what">{decoded.text}</p>
                      <p className="muted">
                        Nonce {doc.safeTx.nonce} · hash <code>{doc.safeTxHash.slice(0, 18)}…</code>
                      </p>
                    </li>
                  );
                })}
              </ol>
              {drafts.some((d) => !decodedText(d).known) ? (
                <Notice tone="error">Hay una operación que esta app no reconoce: no se firma.</Notice>
              ) : (
                <div className="actions">
                  <button type="button" className="button" disabled={sign.pending} onClick={() => void sign.run()}>
                    {signer.kind === 'internal' ? 'Firmar con tu clave R' : 'Firmar con tu wallet'}
                  </button>
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={sign.pending}
                    onClick={() => {
                      setDrafts(null);
                    }}
                  >
                    Volver
                  </button>
                </div>
              )}
              {sign.error && <Notice tone="error">{sign.error}</Notice>}
            </div>
          )}
        </section>
      )}

      <section className="card stack" aria-labelledby="sov-import-title">
        <h2 id="sov-import-title">Importar un documento firmado</h2>
        <p>El documento que firmó U en la app Wallet (o uno que ya tenga las dos firmas).</p>
        <label className="field">
          <span className="field__label">Documento (archivo JSON)</span>
          <input
            type="file"
            accept="application/json,.json"
            className="field__input"
            onChange={(event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              if (file) {
                void readTextFile(file).then(async (text) => {
                  await importDocument(text);
                  input.value = '';
                });
              }
            }}
          />
        </label>
        {scanning === null ? (
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setScanning(new FrameCollector());
            }}
          >
            Leer el QR del documento con la cámara
          </button>
        ) : (
          <QrScanner onText={onQrText} />
        )}
        {progress && (
          <p className="muted">
            Cuadros leídos: {progress.received} de {progress.total}
          </p>
        )}
        {importError && <Notice tone="error">{importError}</Notice>}
      </section>

      {sorted.length > 0 && (
        <section className="card stack" aria-labelledby="sov-docs-title">
          <h2 id="sov-docs-title">Documentos</h2>
          {!payer && (
            <div className="stack">
              <p className="muted">
                Para transmitir vos mismo hace falta una wallet que pague el gas (cualquier cuenta con ETH en Base); si
                no, exportá la calldata para un relayer.
              </p>
              {connectPayer ? (
                <ConnectExternal onConnected={setGasPayer} />
              ) : (
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => {
                    setConnectPayer(true);
                  }}
                >
                  Conectar una wallet para pagar el gas
                </button>
              )}
            </div>
          )}
          <ul className="list">
            {sorted.map((doc) => (
              <DocumentCard
                key={`${doc.safeTxHash}:${doc.signatures.map((s) => s.role).join('')}`}
                doc={doc}
                readiness={readiness[doc.safeTxHash]}
                payer={payer}
                onExecuted={refreshSafe}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
