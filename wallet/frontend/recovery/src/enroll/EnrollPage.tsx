// `/enroll` (P19.T03, [F-LNK-01/02]): desde el enlace o el QR de la Wallet, con el pedido en el fragmento (se saca de
// la URL al leerlo). Login con la misma cuenta → estado del enrollment → step-up ENROLLMENT para esa wallet →
// Enrollment Key (P-256 no extraíble) → R interna (Password R + backups) o wallet externa → prueba de control de R
// (EIP-712) y, en un reemplazo, la KeyAcceptance de R′ → envío firmado por la Enrollment Key → enlace y QR de regreso
// con R y el secreto `k` del pedido (ADR-033: sólo viaja en los fragmentos, nunca al backend; durante el viaje de OAuth
// de Drive queda en el estado de ese viaje, que se borra al volver o si se abandona). Lo que viaja y se muestra es la
// dirección de R (la clave nunca sale de esta app): los textos lo dicen así, y piden copiarla en la Wallet si está en
// otro dispositivo, porque la Wallet no la muestra hasta que coincide ([F-LNK-02]). Sin `k` en el enlace de ida no hay
// enlace de regreso (la Wallet lo cancelaría): sólo la dirección para copiar a mano.
//
// Tercera revisión de P17.MAN: la pantalla dice cuándo vence el pedido (15 min desde que lo generó la Wallet, puede
// llegar con poco tiempo), y lo que dice de dónde queda R es cierto en cada caso: con el sobre recordado en este
// dispositivo (la casilla del cifrado, [F-KEY-07]; se guarda al enviar la dirección), sin recordarlo (R vive en la
// pestaña hasta que se bloquea y después hacen falta sus backups) o con una wallet externa.
//
// Cuarta revisión: la R elegida vive sólo en la sesión (store), nunca en el estado de esta pantalla ([F-KEY-05]): al
// bloquearse Recovery (botón, inactividad, verificación vencida o salida) una R que no se envió se descarta con la
// sesión, y la pantalla lo dice con qué hacer con lo anotado (lo que se estaba creando con una verificación que ya no
// está). Un envío que el backend rechaza por el estado del pedido se explica con el pedido releído (otro más nuevo,
// vencido, cancelado), nunca con «recargá la pantalla», y esa R se descarta. El propósito efectivo (reemplazo si el
// backend lo dice o si el dispositivo ya conoce la R de esa wallet) decide los textos y que nunca se borren sobres en un
// reemplazo; la KeyAcceptance sigue el del pedido, que es lo que exige el backend. La pantalla final pide anotar la
// dirección de R en sus backups.
import { useCallback, useEffect, useState } from 'react';
import { isAddressEqual, type Address, type Hex } from 'viem';
import { ApiError } from '../api/client.ts';
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
import { useSensitiveScreen, useSession, useSessionStore } from '../session/context.tsx';
import { StepUp } from '../session/StepUp.tsx';
import { forgetEnvelope, rememberedEnvelopes, rememberedSafe, rememberEnvelope } from '../storage/envelope-cache.ts';
import { AddressText } from '../ui/AddressText.tsx';
import { describeError } from '../ui/errors.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import { QrCanvas } from '../ui/QrCanvas.tsx';
import { ConnectExternal } from './ConnectExternal.tsx';
import { CreateRecoveryKey } from './CreateRecoveryKey.tsx';
import {
  connectorIdFor,
  effectivePurpose,
  enrollReturnPath,
  enrollmentObject,
  explainSubmitFailure,
  keepEnvelopeOnDevice,
  parseEnrollFragment,
  requestExpiryText,
  returnLink,
  signEnrollmentObject,
  submission,
  type DeviceRecords,
  type EnrollLink,
} from './enrollment.ts';
import {
  ENROLLMENT_IN_USE_TEXT,
  INTERRUPTED_EXTERNAL_TEXT,
  INTERRUPTED_INTERNAL_TEXT,
  lockReasonText,
  R_EXTERNAL_TEXT,
  R_KEEP_FAILED_TEXT,
  rAddressOnBackupsText,
  REGISTER_REREAD_FAILED_TEXT,
  rejectedText,
  rKeptText,
  rNotKeptText,
  RETURN_QR_TEXT,
  RETURN_WITH_SECRET_TEXT,
  RETURN_WITHOUT_SECRET_TEXT,
  STATUS_TEXT,
  unusedText,
} from './texts.ts';

/** El pedido del fragmento, leído una sola vez al cargar la página (y sacado de la URL y del historial). */
function readLink(): EnrollLink | null {
  const link = parseEnrollFragment(window.location.hash);
  if (window.location.hash !== '') window.history.replaceState(window.history.state, '', window.location.pathname);
  return link;
}

/** La clave elegida, sin la clave misma: R interna (con sus backups) o la wallet externa, por su dirección. */
type KeyChoice =
  | { kind: 'internal'; address: Address; flags: StorageFlags; remember: boolean }
  | { kind: 'external'; address: Address };

/** La clave elegida tal como está en la sesión (store): la R desbloqueada o la wallet conectada. */
type Signer = { kind: 'internal'; unlocked: UnlockedRecovery } | { kind: 'external'; session: ExternalSession };

/** Qué quedó de R en este dispositivo al enviar su dirección. */
type Kept = 'external' | 'remembered' | 'not-remembered' | 'remember-failed';

/** Lo enviado: la dirección de R, qué quedó en el dispositivo y si se guardó una copia en Drive. */
interface Sent {
  recoveryKey: Address;
  kept: Kept;
  drive: boolean;
}

/**
 * Una R en curso (Password R generada, R creada o wallet externa conectada) y la verificación con la que empezó: si esa
 * verificación ya no está, Recovery se bloqueó y lo que se estaba creando se descartó con la sesión.
 */
interface Progress {
  kind: 'internal' | 'external';
  session: string;
}

const envelopeStore = { remember: rememberEnvelope, forget: forgetEnvelope };
const deviceRecords: DeviceRecords = { envelopes: rememberedEnvelopes, safeOf: rememberedSafe };

export function EnrollPage() {
  useSensitiveScreen();
  const session = useSession();
  const store = useSessionStore();
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
  const [progress, setProgress] = useState<Progress | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  // El envío no llegó a este pedido y esa R no se va a usar: qué pasó y qué hacer (texto local).
  const [ended, setEnded] = useState<string | null>(null);
  // El dispositivo ya conoce la R de esta wallet (un sobre recordado con su Safe verificada): es un reemplazo.
  const [knownReplacement, setKnownReplacement] = useState(false);

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

  const walletId = enrollment?.walletId ?? null;
  const reportedPurpose = enrollment?.purpose ?? null;
  useEffect(() => {
    if (walletId === null || reportedPurpose === null) return;
    let alive = true;
    void effectivePurpose({ walletId, purpose: reportedPurpose }, deviceRecords).then((found) => {
      if (alive) setKnownReplacement(found === 'REPLACEMENT');
    });
    return () => {
      alive = false;
    };
  }, [walletId, reportedPurpose]);
  const purpose: EnrollmentStatus['purpose'] =
    reportedPurpose === 'REPLACEMENT' || knownReplacement ? 'REPLACEMENT' : 'ONBOARDING';

  const platform = session.platform;
  const platformOk =
    platform !== null &&
    platform.view.scope === 'ENROLLMENT' &&
    enrollment !== null &&
    platform.view.walletId === enrollment.walletId;
  const sessionId = platformOk ? platform.auth.sessionId : null;
  // Lo que se estaba creando con una verificación que ya no está: se descartó al bloquearse (la sesión ya no lo tiene).
  const interrupted = progress !== null && progress.session !== sessionId && sent === null && ended === null;
  // La clave elegida, sólo mientras siga en la sesión (con la misma dirección) y con la verificación con la que empezó.
  const signer: Signer | null = (() => {
    if (choice === null || interrupted) return null;
    if (choice.kind === 'internal') {
      const unlocked = session.recovery;
      return unlocked !== null && isAddressEqual(unlocked.address, choice.address)
        ? { kind: 'internal', unlocked }
        : null;
    }
    const external = session.external;
    return external !== null && isAddressEqual(external.address, choice.address)
      ? { kind: 'external', session: external }
      : null;
  })();
  const ready = choice !== null && signer !== null;
  const shownMode = interrupted ? 'choose' : mode;

  // Con la verificación hecha, la Enrollment Key se registra una vez (un reenvío de la misma JWK no cambia nada).
  const register = useAsyncAction(
    useCallback(async () => {
      if (!link || !platform) return;
      const key = enrollmentKey ?? (await generateSessionKey());
      try {
        await api.registerEnrollmentKey(platform.auth, link.enrollmentId, key.publicJwk);
      } catch (error) {
        // Vencido antes de crear R: no hay ninguna R que descartar (el texto del código es el del envío).
        if (error instanceof ApiError && error.code === 'ENROLLMENT_EXPIRED') {
          throw new Error(STATUS_TEXT.EXPIRED, { cause: error });
        }
        // Otro estado (reemplazado, ya enviado) o la Enrollment Key de otra pestaña: se dice qué pasó con el pedido
        // releído, nunca «recargá la pantalla» (sin el fragmento, recargar pierde el pedido).
        if (error instanceof ApiError && (error.code === 'CONFLICT' || error.status === 409)) {
          const latest = await api.enrollment(link.enrollmentId).catch(() => null);
          if (latest !== null && latest.id === link.enrollmentId && latest.status !== 'REQUESTED') {
            setEnrollment(latest);
            return;
          }
          throw new Error(latest === null ? REGISTER_REREAD_FAILED_TEXT : ENROLLMENT_IN_USE_TEXT, { cause: error });
        }
        throw error;
      }
      setEnrollmentKey(key);
    }, [link, platform, enrollmentKey]),
  );
  // Sólo con el pedido abierto: uno que ya terminó (releído tras un CONFLICT) se muestra con su estado.
  const open = enrollment?.status === 'REQUESTED';
  useEffect(() => {
    if (platformOk && open && enrollmentKey === null && !register.pending && register.error === null) {
      void register.run();
    }
  }, [platformOk, open, enrollmentKey, register]);

  const submit = useAsyncAction(
    useCallback(async () => {
      if (!link || !platform || !enrollment || !enrollmentKey || !choice || !signer || session.user === null) return;
      const recoveryKey = choice.address;
      const factory = systemContracts.contracts.factory.address;
      const proofDefinition = recoveryProofOfControl(factory, {
        userId: session.user.id,
        platformId: appConfig.platformId,
        enrollmentId: link.enrollmentId,
        recoveryKey,
      });
      const sign = (definition: Parameters<typeof signTypedDataWithRecovery>[1]): Promise<Hex> =>
        signer.kind === 'internal'
          ? signTypedDataWithRecovery(signer.unlocked, definition)
          : signer.session.signTypedData(definition);
      const proofOfControl = await sign(proofDefinition);
      // La KeyAcceptance la exige el backend según el propósito del pedido (protocolo, no textos).
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
        external: signer.kind === 'external' ? { connectorId: connectorIdFor(signer.session.connectorId) } : null,
        storageFlags: choice.kind === 'internal' ? choice.flags : null,
        keyAcceptance: acceptance,
      });
      let result: EnrollmentStatus;
      try {
        result = await api.submitEnrollment(platform.auth, link.enrollmentId, body);
      } catch (error) {
        const failure = await explainSubmitFailure(
          error,
          () => api.enrollment(link.enrollmentId),
          link.enrollmentId,
          recoveryKey,
        );
        if (failure.kind === 'retry') throw failure.error;
        if (failure.kind === 'unused') {
          // Esta R no se va a usar: se descarta de la sesión y la pantalla dice qué pasó y qué hacer.
          store.discardKey();
          setChoice(null);
          setProgress(null);
          setEnded(unusedText(failure.cause, choice.kind));
          return;
        }
        // Un envío anterior de esta misma R sí había llegado.
        result = failure.latest;
      }
      // Con la dirección enviada, el sobre cifrado queda en este dispositivo sólo si se pidió ([F-KEY-07]); si el
      // navegador no deja guardarlo, se dice (la pantalla final no puede afirmar que quedó). Con el propósito efectivo
      // releído ahora: en un reemplazo nunca se borra un sobre.
      let kept: Kept = 'external';
      if (choice.kind === 'internal' && signer.kind === 'internal') {
        try {
          const wanted = { remember: choice.remember, purpose: await effectivePurpose(enrollment, deviceRecords) };
          kept = (await keepEnvelopeOnDevice(signer.unlocked.envelope, wanted, envelopeStore))
            ? 'remembered'
            : 'not-remembered';
        } catch {
          kept = choice.remember ? 'remember-failed' : 'not-remembered';
        }
      }
      setEnrollment(result);
      setSent({ recoveryKey, kept, drive: choice.kind === 'internal' && choice.flags.drive });
      // La pantalla final ya no necesita R: queda sólo la de la sesión, que se descarta al bloquear, por inactividad o
      // al cerrar la pestaña.
      setChoice(null);
    }, [link, platform, enrollment, enrollmentKey, choice, signer, session.user, store]),
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

  if (sent) {
    // Sin el `k` del enlace de ida, un enlace de regreso sólo cancelaría el pedido en la Wallet: no se ofrece.
    const recoveryLink = link.secret === null ? null : returnLink(appConfig.walletOrigin, link, sent.recoveryKey);
    return (
      <section className="card stack" aria-labelledby="enroll-done-title" data-kept={sent.kept}>
        <h1 id="enroll-done-title">Dirección de tu clave R enviada</h1>
        <p>
          {sent.kept === 'external'
            ? R_EXTERNAL_TEXT
            : sent.kept === 'remembered'
              ? rKeptText(sent.drive)
              : rNotKeptText(sent.drive)}{' '}
          Volvé a la app Wallet para confirmar su dirección.
        </p>
        {sent.kept === 'remember-failed' && <Notice tone="warning">{R_KEEP_FAILED_TEXT}</Notice>}
        {sent.kept !== 'external' && <Notice tone="warning">{rAddressOnBackupsText(sent.recoveryKey)}</Notice>}
        <p>{recoveryLink === null ? RETURN_WITHOUT_SECRET_TEXT : RETURN_WITH_SECRET_TEXT}</p>
        <p data-recovery-key={sent.recoveryKey}>
          <AddressText address={sent.recoveryKey} copy />
        </p>
        {recoveryLink !== null && (
          <>
            <p>
              <a href={recoveryLink} data-return-link={recoveryLink}>
                Volver a la Wallet
              </a>
            </p>
            <p>{RETURN_QR_TEXT}</p>
            <QrCanvas text={recoveryLink} label="QR para volver a la Wallet con la dirección de tu clave R" />
            <p className="muted">
              El enlace y el QR sirven sólo para el pedido que abriste desde la app Wallet. No los mandes por chat ni
              por email, y no abras enlaces de regreso que te lleguen por esos medios.
            </p>
          </>
        )}
      </section>
    );
  }

  if (ended !== null) {
    return (
      <section className="card stack" aria-labelledby="enroll-ended-title" data-enroll-ended="">
        <h1 id="enroll-ended-title">
          {purpose === 'REPLACEMENT' ? 'Reemplazar tu clave de recuperación' : 'Activar Recovery'}
        </h1>
        <Notice tone="warning">{ended}</Notice>
      </section>
    );
  }

  if (enrollment.status !== 'REQUESTED') {
    return (
      <section className="card stack" aria-labelledby="enroll-status-title">
        <h1 id="enroll-status-title">Activar Recovery</h1>
        <Notice tone={enrollment.status === 'CONFIRMED' ? 'success' : 'warning'}>
          {enrollment.status === 'REJECTED'
            ? rejectedText(enrollment.rejectionReason, purpose)
            : STATUS_TEXT[enrollment.status]}
        </Notice>
      </section>
    );
  }

  /** Empezar otra vez a elegir la clave: lo de un intento descartado ya no cuenta. */
  const choose = (next: 'internal' | 'external') => {
    setChoice(null);
    setProgress(null);
    setMode(next);
  };

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="enroll-title">
        <h1 id="enroll-title">
          {purpose === 'REPLACEMENT' ? 'Reemplazar tu clave de recuperación' : 'Activar Recovery'}
        </h1>
        <p>
          La app Wallet pidió registrar tu clave de recuperación (R). R se crea y se usa en esta app (o es una wallet
          externa tuya), separada de la Wallet: con U y R podés operar tu Safe sin la plataforma.
        </p>
        <p data-request-expires={enrollment.expiresAt}>
          <strong>{requestExpiryText(enrollment.expiresAt)}</strong>
        </p>
      </section>
      {interrupted && (
        <section className="card stack" aria-label="Clave R descartada" data-interrupted={progress.kind}>
          <Notice tone="warning">
            {progress.kind === 'internal' ? INTERRUPTED_INTERNAL_TEXT : INTERRUPTED_EXTERNAL_TEXT}
          </Notice>
          {session.lockReason !== null && <p className="muted">{lockReasonText(session.lockReason)}</p>}
        </section>
      )}
      {!platformOk && (
        <section className="card stack" aria-labelledby="enroll-drive-title">
          <h2 id="enroll-drive-title">Backup en tu Google Drive (opcional)</h2>
          <DriveConnect returnTo={enrollReturnPath(link)}>
            Si querés guardar el sobre cifrado de R en la carpeta privada de Recovery en tu Drive, conectalo ahora,
            antes de verificar tu identidad. Igual vas a necesitar un backup que no dependa de la plataforma ni de Drive
            (archivo, QR o las 17 palabras).
          </DriveConnect>
        </section>
      )}
      {!platformOk && <StepUp scope="ENROLLMENT" walletId={enrollment.walletId} />}
      {platformOk && register.error && <Notice tone="error">{register.error}</Notice>}
      {platformOk && enrollmentKey !== null && !ready && shownMode === 'choose' && (
        <section className="card stack" aria-labelledby="choose-title">
          <h2 id="choose-title">¿Cómo vas a tener tu clave R?</h2>
          <div className="stack">
            <button
              type="button"
              className="button"
              onClick={() => {
                choose('internal');
              }}
            >
              Crear una clave R en este navegador
            </button>
            <p className="muted">
              Esta app genera R, la cifra con una Password R de 5 palabras y te pide al menos un backup (archivo, QR o
              las 17 palabras); si querés, también recuerda el sobre cifrado en este dispositivo.
            </p>
          </div>
          <div className="stack">
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                choose('external');
              }}
            >
              Usar una wallet externa
            </button>
            <p className="muted">
              R es una cuenta común de una wallet tuya, como MetaMask o Coinbase Wallet: la clave queda en esa wallet y
              firma desde ahí. Sus backups son los de esa wallet.
            </p>
          </div>
        </section>
      )}
      {platformOk && enrollmentKey !== null && !ready && shownMode === 'internal' && (
        <CreateRecoveryKey
          walletId={enrollment.walletId}
          purpose={purpose}
          onStarted={() => {
            setChoice(null);
            if (sessionId !== null) setProgress({ kind: 'internal', session: sessionId });
          }}
          onReady={(created) => {
            setChoice({
              kind: 'internal',
              address: created.unlocked.address,
              flags: created.flags,
              remember: created.remember,
            });
          }}
        />
      )}
      {platformOk && enrollmentKey !== null && !ready && shownMode === 'external' && (
        <ConnectExternal
          enrolling
          onConnected={(external) => {
            store.connectExternal(external);
            setChoice({ kind: 'external', address: external.address });
            if (sessionId !== null) setProgress({ kind: 'external', session: sessionId });
          }}
        />
      )}
      {ready && (
        <section className="card stack" aria-labelledby="send-title">
          <h2 id="send-title">Enviar la dirección de tu clave R</h2>
          <p>
            Dirección de tu clave R: <AddressText address={choice.address} />
          </p>
          <p className="muted">
            Tu clave R no sale de esta app: se envía sólo su dirección, con una firma que prueba que la controlás.
          </p>
          <p>
            <strong>{requestExpiryText(enrollment.expiresAt)}</strong>
          </p>
          {submit.error && <Notice tone="error">{submit.error}</Notice>}
          <button type="button" className="button" disabled={submit.pending} onClick={() => void submit.run()}>
            {submit.pending ? 'Firmando y enviando…' : 'Firmar y enviar'}
          </button>
        </section>
      )}
    </div>
  );
}
