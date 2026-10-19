// `/sovereign` (P18.T10, [F-LNK-03]): co-firma de una SafeTx soberana preparada en la app Recovery, sin el backend.
// Importa el documento (archivo JSON o QR multi-frame), abre U en este navegador con el sobre y la Password U (sin
// OPAQUE: tiene que funcionar aunque la plataforma no esté), verifica la Safe por el RPC propio (U tiene que ser owner),
// muestra qué hace la SafeTx decodificada de sus bytes y las firmas que ya trae, U firma el hash recalculado y la app
// exporta el documento con la firma (archivo y QR).
import { useCallback, useEffect, useState } from 'react';
import { getAddress, isAddressEqual } from 'viem';
import { argon2, chainReader } from '../app/services.ts';
import { iSafeAbi } from '../chain/abis/ISafe.ts';
import { pinnedChain } from '../config/chain.ts';
import { systemContracts } from '../config/index.ts';
import { zeroize } from '../crypto/bytes.ts';
import { keysForEnvelope, openEnvelope, type KeyEnvelope } from '../crypto/envelope.ts';
import { normalizePassword } from '../crypto/password.ts';
import { CallDescription } from '../operations/CallDescription.tsx';
import { decodeContext } from '../operations/context.ts';
import { describeParts } from '../operations/describe.ts';
import { addressNames } from '../operations/names.ts';
import { encodeFrames, FrameCollector } from '../qr/frames.ts';
import { failureText } from '../safe/gate.ts';
import { verifySafe } from '../safe/verify.ts';
import { AddressText } from '../ui/AddressText.tsx';
import { downloadText, readTextFile } from '../ui/download.ts';
import { describeError } from '../ui/errors.ts';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import { QrCanvas } from '../ui/QrCanvas.tsx';
import { QrScanner } from '../ui/QrScanner.tsx';
import { EnvelopeSource } from '../unlock/EnvelopeSource.tsx';
import {
  addUserSignature,
  parseSovereignDocument,
  reviewSovereign,
  sovereignContent,
  type SovereignDocument,
  type SovereignReview,
} from './document.ts';

function FrameLoop({ frames }: { frames: string[] }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (frames.length < 2) return undefined;
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % frames.length);
    }, 900);
    return () => {
      clearInterval(timer);
    };
  }, [frames]);
  const frame = frames[index];
  return frame ? (
    <div className="stack">
      <QrCanvas
        text={frame}
        label={`QR del documento firmado, cuadro ${String(index + 1)} de ${String(frames.length)}`}
      />
      <p className="muted" data-frame={index + 1}>
        Cuadro {index + 1} de {frames.length}
      </p>
    </div>
  ) : null;
}

export function SovereignPage() {
  const [doc, setDoc] = useState<SovereignDocument | null>(null);
  const [scan, setScan] = useState(false);
  const [collector] = useState(() => new FrameCollector());
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [envelope, setEnvelope] = useState<KeyEnvelope | null>(null);
  const [key, setKey] = useState<{ envelope: KeyEnvelope; encryptionKey: CryptoKey } | null>(null);
  const [review, setReview] = useState<SovereignReview | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [signed, setSigned] = useState<{ doc: SovereignDocument; frames: string[] } | null>(null);

  const load = useCallback((text: string) => {
    try {
      setImportError(null);
      setDoc(parseSovereignDocument(text));
    } catch (error) {
      setImportError(describeError(error));
    }
  }, []);

  // Estable entre renders: el lector reinicia la cámara si cambia su callback, y cada cuadro leído re-renderiza.
  const onQrText = useCallback(
    (text: string) => {
      setProgress(collector.add(text));
      void collector.content().then((content) => {
        if (content !== null) {
          setScan(false);
          load(content);
        }
      });
    },
    [collector, load],
  );

  const openKey = useAsyncAction(
    useCallback(
      async (password: string) => {
        if (!envelope || !doc) return;
        if (envelope.role !== 'U') throw new Error('Ese sobre no es de una clave U.');
        const keys = await keysForEnvelope(envelope, normalizePassword(password), argon2);
        if (keys.authSecret) zeroize(keys.authSecret);
        zeroize(await openEnvelope(envelope, keys.encryptionKey));
        // U tiene que ser owner de esta Safe on-chain (si no, su firma no sirve).
        const owners = await chainReader.readContract({ address: doc.safe, abi: iSafeAbi, functionName: 'getOwners' });
        if (!owners.some((o) => isAddressEqual(o, envelope.keyAddress))) {
          throw new Error('Tu clave U no es firmante de la Safe de este documento.');
        }
        const check = await verifySafe(
          chainReader,
          { chain: pinnedChain, system: systemContracts },
          { kind: 'unlock', safe: doc.safe, userKey: envelope.keyAddress },
        );
        setWarnings(check.ok ? [] : check.failures);
        setReview(await reviewSovereign(doc, decodeContext(doc.safe)));
        setKey({ envelope, encryptionKey: keys.encryptionKey });
      },
      [envelope, doc],
    ),
  );

  const sign = useAsyncAction(
    useCallback(async () => {
      if (!doc || !review || !key) return;
      const result = await addUserSignature(doc, review, key);
      setSigned({ doc: result, frames: await encodeFrames(sovereignContent(result)) });
    }, [doc, review, key]),
  );

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="sovereign-title">
        <h1 id="sovereign-title">Co-firmar una operación soberana</h1>
        <p>
          Con tu clave U y tu clave R podés operar tu Safe sin la plataforma. La operación se arma en la app Recovery;
          acá la revisás, la firmás con U y exportás la firma. Nada pasa por los servidores de la plataforma.
        </p>
        {!doc && (
          <div className="stack">
            <label className="field">
              <span className="field__label">Documento de la operación (archivo JSON)</span>
              <input
                type="file"
                accept="application/json,.json"
                className="field__input"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) void readTextFile(file).then(load);
                }}
              />
            </label>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setScan(true);
              }}
            >
              Leer el QR con la cámara
            </button>
            {scan && <QrScanner active={scan} onText={onQrText} />}
            {progress && (
              <p className="muted">
                Cuadros leídos: {progress.received} de {progress.total}
              </p>
            )}
            {importError && <Notice tone="error">{importError}</Notice>}
          </div>
        )}
        {doc && (
          <p>
            Safe del documento: <AddressText address={getAddress(doc.safe)} />
          </p>
        )}
      </section>
      {doc && !key && (
        <section className="card stack" aria-labelledby="key-title">
          <h2 id="key-title">Tu clave U</h2>
          {!envelope ? (
            <EnvelopeSource onEnvelope={setEnvelope} allowQr />
          ) : (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void openKey.run(formValue(event.currentTarget, 'passwordU'));
              }}
            >
              <Field label="Password U" name="passwordU" type="password" autoComplete="off" required />
              {openKey.error && <Notice tone="error">{openKey.error}</Notice>}
              <button type="submit" className="button" disabled={openKey.pending} aria-busy={openKey.pending}>
                {openKey.pending ? 'Abriendo…' : 'Abrir mi clave U en este navegador'}
              </button>
            </form>
          )}
        </section>
      )}
      {doc && review && key && !signed && (
        <section className="card stack" aria-labelledby="sov-review-title">
          <h2 id="sov-review-title">Revisá la operación</h2>
          <p className="review__what" data-decoded={review.decoded.kind}>
            <CallDescription
              parts={describeParts(review.decoded, {
                nameOf: addressNames({ safe: getAddress(doc.safe), chain: pinnedChain, system: systemContracts }),
              })}
            />
          </p>
          <p className="muted">
            Nonce {doc.safeTx.nonce} · hash recalculado <code>{review.hash.slice(0, 18)}…</code>
          </p>
          <p>
            Firmas que ya trae:{' '}
            {review.validSignatures.length === 0
              ? 'ninguna'
              : review.validSignatures.map((s) => `${s.role} (${s.signer.slice(0, 10)}…)`).join(', ')}
          </p>
          {warnings.length > 0 && (
            <Notice tone="warning">
              Tu Safe no está en la configuración asistida:
              <ul className="failures">
                {warnings.map((w) => (
                  <li key={w}>{failureText(w)}</li>
                ))}
              </ul>
            </Notice>
          )}
          {review.decoded.kind === 'UNKNOWN' ? (
            <Notice tone="error">Esta app no reconoce la operación: no se firma.</Notice>
          ) : (
            <>
              {sign.error && <Notice tone="error">{sign.error}</Notice>}
              <button
                type="button"
                className="button"
                disabled={sign.pending}
                aria-busy={sign.pending}
                onClick={() => void sign.run()}
              >
                Firmar con tu clave U
              </button>
            </>
          )}
        </section>
      )}
      {signed && (
        <section className="card stack" aria-labelledby="export-title">
          <h2 id="export-title">Firma lista</h2>
          <Notice tone="success">
            Llevá el documento firmado a la app Recovery (archivo o QR) para combinar y transmitir.
          </Notice>
          <button
            type="button"
            className="button"
            onClick={() => {
              downloadText(
                `mtw-sovereign-${signed.doc.safeTxHash.slice(2, 10)}.json`,
                `${JSON.stringify(signed.doc, null, 2)}\n`,
              );
            }}
          >
            Descargar el documento firmado
          </button>
          <FrameLoop frames={signed.frames} />
        </section>
      )}
    </div>
  );
}
