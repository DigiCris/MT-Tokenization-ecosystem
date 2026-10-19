// `/enroll` (P19.T03, [F-LNK-01/02]): desde el link o el QR de la Wallet, con el pedido en el fragmento (se saca de la
// URL al leerlo). Login con la misma cuenta → estado del enrollment → step-up ENROLLMENT para esa wallet → Enrollment
// Key (P-256 no extraíble) → R interna (Password R + backups) o wallet externa → prueba de control de R (EIP-712) y,
// en un reemplazo, la KeyAcceptance de R′ → envío firmado por la Enrollment Key → link y QR de regreso con R.
import { useCallback, useEffect, useState } from 'react';
import type { Address, Hex } from 'viem';
import type { EnrollmentStatus, StorageFlags } from '../api/recovery-api.ts';
import { generateSessionKey, type SessionKey } from '../api/session-key.ts';
import { api } from '../app/services.ts';
import { LoginForm } from '../auth/LoginForm.tsx';
import { appConfig, systemContracts } from '../config/index.ts';
import { DriveConnect } from '../drive/DriveConnect.tsx';
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
  SUBMITTED: 'Ya se envió una clave R para este pedido.',
  CONFIRMED: 'Este pedido ya terminó: la clave R quedó confirmada.',
  EXPIRED: 'El pedido venció (dura 15 minutos): generá uno nuevo desde la app Wallet.',
  REJECTED: 'El pedido fue rechazado: generá uno nuevo desde la app Wallet.',
  RETIRED: 'El pedido fue reemplazado por otro: usá el link más reciente de la app Wallet.',
};

type KeyChoice =
  | { kind: 'internal'; unlocked: UnlockedRecovery; flags: StorageFlags }
  | { kind: 'external'; session: ExternalSession };

export function EnrollPage() {
  useSensitiveScreen();
  const session = useSession();
  const [link] = useState(readLink);
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
        Este link no trae un pedido de la Wallet. Abrí el link o escaneá el QR que muestra la app Wallet al activar
        Recovery.
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

  const recoveryLink = sent ? returnLink(appConfig.walletOrigin, link.enrollmentId, sent.recoveryKey) : null;
  if (recoveryLink && sent) {
    return (
      <section className="card stack" aria-labelledby="enroll-done-title">
        <h1 id="enroll-done-title">Tu clave R quedó enviada</h1>
        <p>Volvé a la app Wallet para confirmarla. Si estás en otro dispositivo, compará esta dirección completa:</p>
        <p data-recovery-key={sent.recoveryKey}>
          <AddressText address={sent.recoveryKey} copy />
        </p>
        <p>
          <a href={recoveryLink} data-return-link={recoveryLink}>
            Volver a la Wallet
          </a>
        </p>
        <QrCanvas text={recoveryLink} label="QR para volver a la Wallet con tu clave R" />
      </section>
    );
  }

  if (enrollment.status !== 'REQUESTED') {
    return (
      <section className="card stack" aria-labelledby="enroll-status-title">
        <h1 id="enroll-status-title">Activar Recovery</h1>
        <Notice tone={enrollment.status === 'CONFIRMED' ? 'success' : 'warning'}>
          {STATUS_TEXT[enrollment.status]}
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
          <h2 id="send-title">Enviar tu clave R</h2>
          <p>
            Clave R:{' '}
            <AddressText address={choice.kind === 'internal' ? choice.unlocked.address : choice.session.address} />
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
