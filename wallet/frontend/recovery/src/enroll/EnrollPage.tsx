// `/enroll` (P19.T03, [F-LNK-01/02]): desde el enlace o el QR de la Wallet, con el pedido en el fragmento (se saca de
// la URL al leerlo). Login con la misma cuenta → estado del enrollment → step-up ENROLLMENT para esa wallet →
// Enrollment Key (P-256 no extraíble) → R interna (Password R + backups) o wallet externa → prueba de control de R
// (EIP-712) y, en un reemplazo, la KeyAcceptance de R′ → envío firmado por la Enrollment Key → enlace y QR de regreso
// con R y el secreto `k` del pedido (ADR-033: sólo viaja en los fragmentos, nunca al backend; durante el viaje de OAuth
// de Drive queda en el estado de ese viaje, que se borra al volver o si se abandona). Lo que viaja y se muestra es la
// dirección de R (la clave nunca sale de esta app): los textos lo dicen así, y piden copiarla en la Wallet si está en
// otro dispositivo, porque la Wallet no la muestra hasta que coincide ([F-LNK-02]).
import { useCallback, useEffect, useState } from 'react';
import type { Address, Hex } from 'viem';
import type { EnrollmentStatus, StorageFlags } from '../api/recovery-api.ts';
import { generateSessionKey, type SessionKey } from '../api/session-key.ts';
import { api } from '../app/services.ts';
import { LoginForm } from '../auth/LoginForm.tsx';
import { appConfig, systemContracts } from '../config/index.ts';
import { DriveConnect } from '../drive/DriveConnect.tsx';
import { discardOAuthState } from '../drive/oauth-state.ts';
import { signTypedDataWithRecovery, type UnlockedRecovery } from '../crypto/session.ts';
import { keyAcceptance, recoveryProofOfControl } from '../crypto/typed-data.ts';
import type { ExternalSession } from '../external-wallet/types.ts';
import { useSensitiveScreen, useSession } from '../session/context.tsx';
import { StepUp } from '../session/StepUp.tsx';
import { AddressText } from '../ui/AddressText.tsx';
import { describeError } from '../ui/errors.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import { QrCanvas } from '../ui/QrCanvas.tsx';
import { ConnectExternal } from './ConnectExternal.tsx';
import { CreateRecoveryKey } from './CreateRecoveryKey.tsx';
import {
  connectorIdFor,
  enrollReturnPath,
  enrollmentObject,
  parseEnrollFragment,
  returnLink,
  signEnrollmentObject,
  submission,
  type EnrollLink,
} from './enrollment.ts';

/** El pedido del fragmento, leído una sola vez al cargar la página (y sacado de la URL y del historial). */
function readLink(): EnrollLink | null {
  const link = parseEnrollFragment(window.location.hash);
  if (window.location.hash !== '') window.history.replaceState(window.history.state, '', window.location.pathname);
  return link;
}

const STATUS_TEXT: Record<EnrollmentStatus['status'], string> = {
  REQUESTED: 'Pendiente',
  SUBMITTED: 'Ya se envió la dirección de una clave R para este pedido.',
  CONFIRMED: 'Este pedido ya terminó: la Wallet confirmó la dirección de tu clave R.',
  EXPIRED: 'El pedido venció (dura 15 minutos): generá uno nuevo desde la app Wallet.',
  REJECTED: 'El pedido fue rechazado: generá uno nuevo desde la app Wallet.',
  RETIRED: 'El pedido fue reemplazado por otro: usá el enlace más reciente de la app Wallet.',
};

/** Un pedido rechazado: reemplazado por uno más nuevo o cancelado por la Wallet porque no pudo confirmar R. */
function rejectedText(reason: EnrollmentStatus['rejectionReason']): string {
  if (reason === 'SUPERSEDED') {
    return 'La app Wallet generó un pedido más nuevo: usá el enlace o el QR más reciente de la app Wallet.';
  }
  if (reason === null || reason === undefined) return STATUS_TEXT.REJECTED;
  return 'La app Wallet canceló este pedido porque no pudo confirmar la dirección de tu clave R. Generá uno nuevo desde la app Wallet: Recovery va a crear otra clave R, y los backups de la anterior ya no sirven.';
}

type KeyChoice =
  | { kind: 'internal'; unlocked: UnlockedRecovery; flags: StorageFlags }
  | { kind: 'external'; session: ExternalSession };

export function EnrollPage() {
  useSensitiveScreen();
  const session = useSession();
  const [link] = useState(readLink);
  // Al montar sin venir del callback de Google, un viaje de OAuth anterior quedó abandonado: su estado (con la ruta de
  // regreso y el `k` del pedido) no se deja en la pestaña. Al volver del callback ya se consumió, así que no hay nada.
  useEffect(() => {
    discardOAuthState();
  }, []);
  // Un enlace de ida nuevo abierto en esta misma pestaña sólo cambia el fragmento (misma ruta): el navegador no recarga
  // y el pedido se lee al cargar. Se recarga para tomarlo como cualquier enlace nuevo; lo del pedido anterior en memoria
  // (también una R generada) se descarta, como pide un pedido nuevo.
  useEffect(() => {
    const onHashChange = () => {
      if (parseEnrollFragment(window.location.hash) !== null) window.location.reload();
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);
  const [enrollment, setEnrollment] = useState<EnrollmentStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enrollmentKey, setEnrollmentKey] = useState<SessionKey | null>(null);
  const [mode, setMode] = useState<'choose' | 'internal' | 'external'>('choose');
  const [choice, setChoice] = useState<KeyChoice | null>(null);
  const [sent, setSent] = useState<{ recoveryKey: Address } | null>(null);

  useEffect(() => {
    if (link === null || session.status !== 'account') return;
    let alive = true;
    api
      .enrollment(link.enrollmentId)
      .then((current) => {
        if (alive) setEnrollment(current);
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(describeError(error));
      });
    return () => {
      alive = false;
    };
  }, [link, session.status]);

  const platform = session.platform;
  const platformOk =
    platform !== null &&
    platform.view.scope === 'ENROLLMENT' &&
    enrollment !== null &&
    platform.view.walletId === enrollment.walletId;

  // Con la verificación hecha, la Enrollment Key se registra una vez (un reenvío de la misma JWK no cambia nada).
  const register = useAsyncAction(
    useCallback(async () => {
      if (!link || !platform) return;
      const key = enrollmentKey ?? (await generateSessionKey());
      await api.registerEnrollmentKey(platform.auth, link.enrollmentId, key.publicJwk);
      setEnrollmentKey(key);
    }, [link, platform, enrollmentKey]),
  );
  useEffect(() => {
    if (platformOk && enrollmentKey === null && !register.pending && register.error === null) void register.run();
  }, [platformOk, enrollmentKey, register]);

  const submit = useAsyncAction(
    useCallback(async () => {
      if (!link || !platform || !enrollment || !enrollmentKey || !choice || session.user === null) return;
      const recoveryKey = choice.kind === 'internal' ? choice.unlocked.address : choice.session.address;
      const factory = systemContracts.contracts.factory.address;
      const proofDefinition = recoveryProofOfControl(factory, {
        userId: session.user.id,
        platformId: appConfig.platformId,
        enrollmentId: link.enrollmentId,
        recoveryKey,
      });
      const sign = (definition: Parameters<typeof signTypedDataWithRecovery>[1]): Promise<Hex> =>
        choice.kind === 'internal'
          ? signTypedDataWithRecovery(choice.unlocked, definition)
          : choice.session.signTypedData(definition);
      const proofOfControl = await sign(proofDefinition);
      const acceptance =
        enrollment.purpose === 'REPLACEMENT'
          ? {
              nonce: link.nonce,
              signature: await sign(
                keyAcceptance(factory, { walletId: enrollment.walletId, newKey: recoveryKey, nonce: link.nonce }),
              ),
            }
          : null;
      const object = enrollmentObject({
        userId: session.user.id,
        platformId: appConfig.platformId,
        recoveryKey,
        nonce: link.nonce,
        nowMs: api.client.clock.nowMs(),
      });
      const body = submission({
        object,
        enrollmentKeySignature: await signEnrollmentObject(enrollmentKey.privateKey, object),
        proofOfControl,
        external: choice.kind === 'external' ? { connectorId: connectorIdFor(choice.session.connectorId) } : null,
        storageFlags: choice.kind === 'internal' ? choice.flags : null,
        keyAcceptance: acceptance,
      });
      const result = await api.submitEnrollment(platform.auth, link.enrollmentId, body);
      setEnrollment(result);
      setSent({ recoveryKey });
    }, [link, platform, enrollment, enrollmentKey, choice, session.user]),
  );

  if (link === null && enrollment === null) {
    return (
      <Notice tone="error">
        Este enlace no trae un pedido de la app Wallet. Abrí el enlace o escaneá el QR que muestra la app Wallet al
        activar Recovery.
      </Notice>
    );
  }

  if (session.status === 'loading') return <p className="muted">Cargando…</p>;
  if (session.status !== 'account') {
    return (
      <section className="card stack narrow" aria-labelledby="enroll-login-title">
        <h1 id="enroll-login-title">Activar Recovery</h1>
        <p>Iniciá sesión con la misma cuenta que usás en la app Wallet.</p>
        <LoginForm onSignedIn={() => undefined} />
      </section>
    );
  }

  if (loadError) return <Notice tone="error">{loadError}</Notice>;
  if (enrollment === null || link === null) return <p className="muted">Leyendo el pedido…</p>;

  const recoveryLink = sent ? returnLink(appConfig.walletOrigin, link, sent.recoveryKey) : null;
  if (recoveryLink && sent) {
    return (
      <section className="card stack" aria-labelledby="enroll-done-title">
        <h1 id="enroll-done-title">Dirección de tu clave R enviada</h1>
        <p>
          Tu clave R queda en esta app: a la plataforma sólo le llegó su dirección. Volvé a la app Wallet para
          confirmarla.
        </p>
        <p>
          Si la Wallet está en este dispositivo, abrí «Volver a la Wallet»: la dirección se confirma sola en la pestaña
          donde generaste el pedido. Si está en otro dispositivo, copiá ahí esta dirección completa, grupo por grupo (da
          igual mayúsculas o minúsculas):
        </p>
        <p data-recovery-key={sent.recoveryKey}>
          <AddressText address={sent.recoveryKey} copy />
        </p>
        <p>
          <a href={recoveryLink} data-return-link={recoveryLink}>
            Volver a la Wallet
          </a>
        </p>
        <QrCanvas text={recoveryLink} label="QR para volver a la Wallet con la dirección de tu clave R" />
        <p className="muted">
          El enlace y el QR sirven sólo para el pedido que abriste desde la app Wallet. No los mandes por chat ni por
          email, y no abras enlaces de regreso que te lleguen por esos medios.
        </p>
      </section>
    );
  }

  if (enrollment.status !== 'REQUESTED') {
    return (
      <section className="card stack" aria-labelledby="enroll-status-title">
        <h1 id="enroll-status-title">Activar Recovery</h1>
        <Notice tone={enrollment.status === 'CONFIRMED' ? 'success' : 'warning'}>
          {enrollment.status === 'REJECTED' ? rejectedText(enrollment.rejectionReason) : STATUS_TEXT[enrollment.status]}
        </Notice>
      </section>
    );
  }

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="enroll-title">
        <h1 id="enroll-title">
          {enrollment.purpose === 'REPLACEMENT' ? 'Reemplazar tu clave de recuperación' : 'Activar Recovery'}
        </h1>
        <p>
          La app Wallet pidió registrar tu clave de recuperación (R). R vive en esta app, separada de la Wallet: con U y
          R podés operar tu Safe sin la plataforma.
        </p>
      </section>
      {!platformOk && (
        <section className="card stack" aria-labelledby="enroll-drive-title">
          <h2 id="enroll-drive-title">Backup en tu Google Drive (opcional)</h2>
          <DriveConnect returnTo={enrollReturnPath(link)}>
            Si querés guardar el sobre cifrado de R en la carpeta privada de Recovery en tu Drive, conectalo ahora,
            antes de verificar tu identidad. Igual vas a necesitar un backup fuera de la plataforma (archivo, QR o
            palabras).
          </DriveConnect>
        </section>
      )}
      {!platformOk && <StepUp scope="ENROLLMENT" walletId={enrollment.walletId} />}
      {platformOk && register.error && <Notice tone="error">{register.error}</Notice>}
      {platformOk && enrollmentKey !== null && choice === null && mode === 'choose' && (
        <section className="card stack" aria-labelledby="choose-title">
          <h2 id="choose-title">¿Dónde va a vivir tu clave R?</h2>
          <div className="actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                setMode('internal');
              }}
            >
              Crear una clave R en este navegador
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setMode('external');
              }}
            >
              Usar una wallet externa
            </button>
          </div>
        </section>
      )}
      {platformOk && enrollmentKey !== null && choice === null && mode === 'internal' && (
        <CreateRecoveryKey
          walletId={enrollment.walletId}
          onReady={(ready) => {
            setChoice({ kind: 'internal', ...ready });
          }}
        />
      )}
      {platformOk && enrollmentKey !== null && choice === null && mode === 'external' && (
        <ConnectExternal
          onConnected={(external) => {
            setChoice({ kind: 'external', session: external });
          }}
        />
      )}
      {choice !== null && (
        <section className="card stack" aria-labelledby="send-title">
          <h2 id="send-title">Enviar la dirección de tu clave R</h2>
          <p>
            Dirección de tu clave R:{' '}
            <AddressText address={choice.kind === 'internal' ? choice.unlocked.address : choice.session.address} />
          </p>
          <p className="muted">
            Tu clave R no sale de esta app: se envía sólo su dirección, con una firma que prueba que la controlás.
          </p>
          {!platformOk && <Notice tone="warning">La verificación venció: hacela de nuevo para enviar.</Notice>}
          {submit.error && <Notice tone="error">{submit.error}</Notice>}
          <button
            type="button"
            className="button"
            disabled={submit.pending || !platformOk}
            onClick={() => void submit.run()}
          >
            {submit.pending ? 'Firmando y enviando…' : 'Firmar y enviar'}
          </button>
        </section>
      )}
    </div>
  );
}
