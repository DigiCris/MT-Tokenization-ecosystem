// Desbloquear R ([F-SES-02], [F-KEY-05]): el sobre `R.enc` sale del dispositivo (recordado), de un archivo o del QR (sólo
// en las rutas con cámara) y se abre con la Password R (Argon2id en el worker). En memoria quedan el sobre y K_R no
// exportable; R se descifra sólo para cada firma. Cuarta revisión de P17.MAN (hallazgos 6 y 12): cada sobre recordado se
// ofrece con la dirección completa de su R (puede haber uno de un pedido anterior o de R′ en un reemplazo, y se avisa si
// hay más de uno de la misma wallet), y quien sólo tiene las 17 palabras sabe que primero las restaura en /restore.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { argon2 } from '../app/services.ts';
import { openRecoveryEnvelope, parseRecoveryEnvelope, type RecoveryEnvelope } from '../crypto/envelope.ts';
import { normalizePasswordR } from '../crypto/password.ts';
import { loadWordlist } from '../crypto/wordlist.ts';
import { FrameCollector } from '../qr/frames.ts';
import { useSessionStore } from '../session/context.tsx';
import { SEVERAL_ENVELOPES_TEXT } from '../session/texts.ts';
import { rememberEnvelope, rememberedEnvelopes } from '../storage/envelope-cache.ts';
import { AddressText, groupedAddress } from '../ui/AddressText.tsx';
import { readTextFile } from '../ui/download.ts';
import { describeError } from '../ui/errors.ts';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import { QrScanner } from '../ui/QrScanner.tsx';
import type { UnlockedRecovery } from '../crypto/session.ts';

export function UnlockRecovery({
  walletId,
  allowCamera = false,
  wordsHint = false,
  onUnlocked,
}: {
  /** Si se sabe la wallet, sólo se acepta su sobre. */
  walletId?: string;
  allowCamera?: boolean;
  /** Ofrecer el camino de las 17 palabras (restaurar R en /restore, que necesita la plataforma, y volver). */
  wordsHint?: boolean;
  onUnlocked?: (unlocked: UnlockedRecovery) => void;
}) {
  const store = useSessionStore();
  const [remembered, setRemembered] = useState<RecoveryEnvelope[]>([]);
  const [envelope, setEnvelope] = useState<RecoveryEnvelope | null>(null);
  const [scanning, setScanning] = useState(false);
  const [collector] = useState(() => new FrameCollector());
  const [progress, setProgress] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);

  useEffect(() => {
    rememberedEnvelopes()
      .then((found) => {
        setRemembered(walletId === undefined ? found : found.filter((e) => e.walletId === walletId));
      })
      .catch(() => undefined);
  }, [walletId]);

  const choose = useCallback(
    (candidate: unknown) => {
      try {
        const parsed = parseRecoveryEnvelope(candidate);
        if (walletId !== undefined && parsed.walletId !== walletId) {
          throw new Error('Ese sobre es de otra wallet.');
        }
        setSourceError(null);
        setEnvelope(parsed);
      } catch (error) {
        setSourceError(describeError(error));
      }
    },
    [walletId],
  );

  const onQrText = useCallback(
    (text: string) => {
      const step = collector.add(text);
      if (step) setProgress(`Cuadros leídos: ${String(step.received)} de ${String(step.total)}`);
      void collector
        .content()
        .then((content) => {
          if (content === null) return;
          setScanning(false);
          choose(JSON.parse(content));
        })
        .catch((error: unknown) => {
          setSourceError(describeError(error));
        });
    },
    [collector, choose],
  );

  const severalPerWallet = remembered.some(
    (e, i) => remembered.findIndex((other) => other.walletId === e.walletId) !== i,
  );

  const unlock = useAsyncAction(
    useCallback(
      async (password: string, remember: boolean) => {
        if (!envelope) return;
        const wordlist = await loadWordlist();
        const opened = await openRecoveryEnvelope(envelope, normalizePasswordR(password, wordlist), argon2);
        if (remember) await rememberEnvelope(envelope);
        store.unlockRecovery(opened);
        onUnlocked?.(opened);
      },
      [envelope, store, onUnlocked],
    ),
  );

  return (
    <section className="card stack" aria-labelledby="unlock-title">
      <h2 id="unlock-title">Desbloqueá tu clave de recuperación (R)</h2>
      {!envelope ? (
        <div className="stack">
          <p>Elegí el sobre cifrado de R (el archivo que guardaste, el QR o el recordado en este dispositivo).</p>
          {severalPerWallet && <Notice tone="warning">{SEVERAL_ENVELOPES_TEXT}</Notice>}
          {remembered.map((e) => (
            <button
              key={`${e.walletId}:${e.keyAddress}`}
              type="button"
              className="button button--secondary"
              data-remembered-envelope={e.keyAddress}
              onClick={() => {
                setEnvelope(e);
              }}
            >
              Usar el sobre recordado de la clave R con la dirección <code>{groupedAddress(e.keyAddress)}</code>
            </button>
          ))}
          <label className="field">
            <span className="field__label">Archivo del sobre cifrado (R.enc)</span>
            <input
              type="file"
              accept="application/json,.json"
              className="field__input"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) {
                  void readTextFile(file).then((text) => {
                    try {
                      choose(JSON.parse(text));
                    } catch {
                      setSourceError('El archivo no es un sobre cifrado de MT Wallet.');
                    }
                  });
                }
              }}
            />
          </label>
          {allowCamera && !scanning && (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setScanning(true);
              }}
            >
              Leer el QR del sobre con la cámara
            </button>
          )}
          {scanning && <QrScanner onText={onQrText} />}
          {progress && <p className="muted">{progress}</p>}
          {sourceError && <Notice tone="error">{sourceError}</Notice>}
          {wordsHint && (
            <p className="muted" data-words-hint="">
              ¿Tenés sólo las 17 palabras de R? Primero restaurala en{' '}
              <Link to="/restore" reloadDocument>
                «Restaurar mi clave R»
              </Link>{' '}
              (sirve también en este dispositivo) y volvé.
            </p>
          )}
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const remember = (form.elements.namedItem('remember') as HTMLInputElement | null)?.checked ?? false;
            void unlock.run(formValue(form, 'passwordR'), remember);
          }}
        >
          <p>
            Sobre cifrado de la clave R con la dirección <AddressText address={envelope.keyAddress} />
          </p>
          <Field
            label="Password R"
            name="passwordR"
            type="password"
            autoComplete="off"
            required
            hint="Las 5 palabras."
          />
          <label className="check">
            <input type="checkbox" name="remember" /> Recordar el sobre cifrado en este dispositivo
          </label>
          {unlock.error && <Notice tone="error">{unlock.error}</Notice>}
          <div className="actions">
            <button type="submit" className="button" disabled={unlock.pending}>
              {unlock.pending ? 'Abriendo el sobre…' : 'Desbloquear R'}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setEnvelope(null);
              }}
            >
              Elegir otro sobre
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
