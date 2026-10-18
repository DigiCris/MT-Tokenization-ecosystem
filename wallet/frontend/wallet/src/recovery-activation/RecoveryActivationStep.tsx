// Activar Recovery (P18.T01 en el onboarding y P18.T09.a para reemplazar R): pide el enrollment, muestra el link y el QR
// para la app Recovery, espera a que Recovery envíe R y la confirma con el link de regreso (otra pestaña, por
// BroadcastChannel) o con la comparación manual de la dirección completa (sus 10 grupos). Recién con R confirmada sigue.
// Si el link de regreso trae otra R que la que informa la plataforma, ese pedido se aborta: no se puede confirmar a mano
// y hay que generar uno nuevo.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import type { PlatformAuth } from '../api/request-signature.ts';
import type { CreatedEnrollment, RecoveryEnrollment } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { appConfig } from '../config/index.ts';
import { AddressText } from '../ui/AddressText.tsx';
import { Field, Notice, useAsyncAction } from '../ui/forms.tsx';
import { QrCanvas } from '../ui/QrCanvas.tsx';
import { describeError } from '../ui/errors.ts';
import {
  addressGroups,
  confirmManually,
  confirmWithReturnLink,
  RecoveryKeyMismatchError,
  recoveryEnrollLink,
  submittedRecoveryKey,
} from './activation.ts';
import { listenForReturn } from './return-channel.ts';

export interface ConfirmedRecovery {
  recoveryKey: Address;
  enrollmentId: string;
  /** null si se confirmó desde el link de regreso en otra pestaña que retomó la creación. */
  enrollmentNonce: `0x${string}` | null;
}

export function RecoveryActivationStep({
  walletId,
  platform,
  onConfirmed,
  intro,
}: {
  walletId: string;
  platform: PlatformAuth;
  onConfirmed: (confirmed: ConfirmedRecovery) => void;
  intro: string;
}) {
  const [created, setCreated] = useState<CreatedEnrollment | null>(null);
  const [enrollment, setEnrollment] = useState<RecoveryEnrollment | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [typed, setTyped] = useState<string[]>(() => Array.from({ length: 10 }, () => ''));
  const [linkError, setLinkError] = useState<string | null>(null);
  const [aborted, setAborted] = useState(false);

  const create = useAsyncAction(
    useCallback(async () => {
      // Sin pedido mientras se crea el nuevo: el polling y el link de regreso del anterior se cortan (sus respuestas
      // tardías se descartan) y no vuelven a poblar el paso con su R.
      setCreated(null);
      setEnrollment(null);
      setAborted(false);
      setLinkError(null);
      setTyped(Array.from({ length: 10 }, () => ''));
      setCreated(await api.createRecoveryEnrollment(platform, walletId));
    }, [platform, walletId]),
  );

  // Un enrollment por montaje del paso (uno nuevo reemplaza a los anteriores en el backend).
  const start = create.run;
  useEffect(() => {
    void start();
  }, [start]);

  const reported = (() => {
    try {
      return enrollment ? submittedRecoveryKey(enrollment) : null;
    } catch {
      return null;
    }
  })();

  // Espera a que Recovery envíe R (o a que el pedido venza).
  useEffect(() => {
    if (created === null || reported !== null) return undefined;
    let live = true;
    const tick = () => {
      api
        .getRecoveryEnrollment(created.enrollmentId)
        .then((current) => {
          if (!live) return;
          setEnrollment(current);
          submittedRecoveryKey(current);
        })
        .catch((error: unknown) => {
          if (live) setPollError(describeError(error));
        });
    };
    tick();
    const timer = setInterval(tick, 3_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [created, reported]);

  const finish = useCallback(
    (recoveryKey: Address) => {
      if (!created) return;
      onConfirmed({ recoveryKey, enrollmentId: created.enrollmentId, enrollmentNonce: created.nonce });
    },
    [created, onConfirmed],
  );

  // Link de regreso abierto en otra pestaña (sólo el del pedido vigente: lo que llega tarde de otro se descarta).
  useEffect(() => {
    if (created === null) return undefined;
    const alive = { current: true };
    const stop = listenForReturn(created.enrollmentId, (recoveryKey) => {
      void api
        .getRecoveryEnrollment(created.enrollmentId)
        .then((current) => {
          if (!alive.current) return;
          setEnrollment(current);
          finish(
            confirmWithReturnLink(current, { enrollmentId: created.enrollmentId, recoveryKey: recoveryKey as Address }),
          );
        })
        .catch((error: unknown) => {
          if (!alive.current) return;
          if (error instanceof RecoveryKeyMismatchError) setAborted(true);
          setLinkError(describeError(error));
        });
    });
    return () => {
      alive.current = false;
      stop();
    };
  }, [created, finish]);

  const [manualError, setManualError] = useState<string | null>(null);
  const link = created ? recoveryEnrollLink(appConfig.recoveryOrigin, created) : null;

  return (
    <article className="card stack" aria-labelledby="recovery-title">
      <h2 id="recovery-title">Activar Recovery</h2>
      <p>{intro}</p>
      {create.error && (
        <>
          <Notice tone="error">{create.error}</Notice>
          <button type="button" className="button" onClick={() => void create.run()}>
            Reintentar
          </button>
        </>
      )}
      {link && reported === null && (
        <div className="stack">
          <p>
            Abrí este link en la app Recovery (en este dispositivo o en otro, con el QR). El link no viaja a ningún
            servidor: lleva el pedido en el fragmento.
          </p>
          <p>
            <a href={link} target="_blank" rel="noopener noreferrer" data-recovery-link={link}>
              Abrir la app Recovery
            </a>
          </p>
          <QrCanvas text={link} label="QR para abrir la app Recovery con este pedido" />
          <Notice>Esperando que Recovery envíe tu clave R…</Notice>
          {pollError && <Notice tone="error">{pollError}</Notice>}
          {enrollment?.status === 'EXPIRED' && (
            <button type="button" className="button" onClick={() => void create.run()}>
              El pedido venció: generar uno nuevo
            </button>
          )}
        </div>
      )}
      {reported !== null && aborted && (
        <div className="stack">
          <Notice tone="error">{linkError}</Notice>
          <button type="button" className="button" onClick={() => void create.run()}>
            Generar un pedido nuevo
          </button>
        </div>
      )}
      {reported !== null && !aborted && (
        <div className="stack">
          <p>Recovery envió esta clave R:</p>
          <p>
            <AddressText address={reported} />
          </p>
          <p>
            Si abriste el link de regreso de Recovery se confirma sola. Si no, copiá de la pantalla de Recovery la
            dirección completa, grupo por grupo (cada grupo son 4 caracteres):
          </p>
          {linkError && <Notice tone="error">{linkError}</Notice>}
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!enrollment) return;
              try {
                setManualError(null);
                finish(confirmManually(enrollment, typed));
              } catch (error) {
                setManualError(describeError(error));
              }
            }}
          >
            {addressGroups(reported).map((_, i) => (
              <Field
                key={i}
                label={`Grupo ${String(i + 1)} de ${String(addressGroups(reported).length)}`}
                name={`group-${String(i)}`}
                autoComplete="off"
                spellCheck={false}
                maxLength={4}
                required
                value={typed[i] ?? ''}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setTyped((current) => current.map((v, j) => (j === i ? value : v)));
                }}
              />
            ))}
            {manualError && <Notice tone="error">{manualError}</Notice>}
            <button type="submit" className="button">
              Confirmar la clave R
            </button>
          </form>
        </div>
      )}
    </article>
  );
}
