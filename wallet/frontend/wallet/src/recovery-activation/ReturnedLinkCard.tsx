// Enlace de regreso de Recovery abierto en una pestaña que no tiene el pedido (ninguna otra lo tomó: la del pedido se
// cerró, se recargó o está en otro dispositivo). Esta pestaña no conoce el secreto `k` del pedido (ADR-033: vive sólo en
// la memoria de la pestaña que lo generó), así que el enlace no confirma nada acá (hallazgos N2 y N6 de la segunda
// revisión de P17.MAN). Sin `k`, además, no lo armó la app Recovery: se cancela ese pedido y se informa (N10).
//
// Revisión de seguridad de ADR-033 (BAJO 5): la explicación sale enseguida, sin pasar por el onboarding (antes había
// que abrir el sobre con la Password U y hacer el step-up), también en el reemplazo de R con la wallet ya activa. El
// aviso del enlace falsificado va con la sesión del propósito del pedido (que se lee del backend): ONBOARDING con un
// step-up acá mismo, u OPERATIONS al desbloquear la wallet; mientras tanto queda en la cola de avisos. Ningún texto de la
// plataforma se muestra.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { abortReports, api } from '../app/services.ts';
import { useSession } from '../session/context.tsx';
import { StepUpForm } from '../session/StepUpForm.tsx';
import { Notice } from '../ui/forms.tsx';
import type { EnrollmentPurpose } from './abort-reports.ts';
import {
  beforeNewRequestText,
  RETURN_LINK_ELSEWHERE_TEXT,
  ReturnLinkUnverifiedError,
  type RecoveryReturn,
} from './activation.ts';

/** El propósito del pedido del enlace: undefined mientras se lee, null si no se pudo leer (otro usuario, sin red). */
type Purpose = EnrollmentPurpose | null | undefined;

/** El aviso de ese pedido ya llegó al backend (no queda en la cola). */
const delivered = (enrollmentId: string) => !abortReports.pending().some((p) => p.enrollmentId === enrollmentId);

/** Dónde sigue el usuario para generar un pedido nuevo, según el propósito. */
function ContinueLink({ purpose }: { purpose: Purpose }) {
  if (purpose === 'ONBOARDING') return <Link to="/onboarding">Seguir con la creación de tu wallet</Link>;
  if (purpose === 'REPLACEMENT') return <Link to="/security/recovery">Ir a tu clave de recuperación</Link>;
  return <Link to="/">Ir al inicio</Link>;
}

export function ReturnedLinkCard({ returned }: { returned: RecoveryReturn }) {
  const { unlocked } = useSession();
  const forged = returned.secret === null;
  const [purpose, setPurpose] = useState<Purpose>(undefined);
  // El aviso del enlace falsificado: en la cola hasta que llegue con una sesión del propósito del pedido.
  const [reported, setReported] = useState<'pending' | 'sent'>('pending');
  const queued = useRef(false);

  useEffect(() => {
    let live = true;
    api
      .getRecoveryEnrollment(returned.enrollmentId)
      .then((enrollment) => {
        if (live) setPurpose(enrollment.purpose);
      })
      .catch(() => {
        if (live) setPurpose(null);
      });
    return () => {
      live = false;
    };
  }, [returned.enrollmentId]);

  useEffect(() => {
    if (!forged || purpose === undefined || queued.current) return;
    queued.current = true;
    void abortReports.report({ enrollmentId: returned.enrollmentId, reason: 'RETURN_LINK_UNVERIFIED', purpose });
  }, [forged, purpose, returned.enrollmentId]);

  // Con la wallet desbloqueada (OPERATIONS), el aviso de un reemplazo de R sale ya.
  useEffect(() => {
    if (!forged || purpose === undefined || purpose === 'ONBOARDING' || unlocked === null) return undefined;
    let live = true;
    void abortReports
      .flush({ platform: unlocked.platform, purpose: 'REPLACEMENT', expiresAt: unlocked.session.expiresAt })
      .then(() => {
        if (live && delivered(returned.enrollmentId)) setReported('sent');
      });
    return () => {
      live = false;
    };
  }, [forged, purpose, unlocked, returned.enrollmentId]);

  return (
    <article className="card stack narrow" aria-labelledby="return-title">
      <h1 id="return-title">Volviste desde la app Recovery</h1>
      {forged ? (
        <Notice tone="error">{new ReturnLinkUnverifiedError().message}</Notice>
      ) : (
        <Notice tone="warning">{RETURN_LINK_ELSEWHERE_TEXT}</Notice>
      )}
      <p>{beforeNewRequestText(purpose)}</p>
      <p>
        <ContinueLink purpose={purpose} />
      </p>
      {forged && reported === 'sent' && <Notice tone="success">La plataforma ya registró el aviso.</Notice>}
      {forged && reported === 'pending' && purpose === 'ONBOARDING' && (
        <section className="stack" aria-labelledby="report-title">
          <h2 id="report-title">Avisale a la plataforma</h2>
          <p>
            Para que quede registrado (y te llegue la alerta por email), confirmá que sos vos. Si seguís con la creación
            de tu wallet en esta pestaña, el aviso sale solo.
          </p>
          <StepUpForm
            scope="ONBOARDING"
            onSession={(session) => {
              void abortReports
                .flush({ platform: session.platform, purpose: 'ONBOARDING', expiresAt: session.session.expiresAt })
                .then(() => {
                  if (delivered(returned.enrollmentId)) setReported('sent');
                });
            }}
          />
        </section>
      )}
      {forged && reported === 'pending' && purpose === 'REPLACEMENT' && unlocked === null && (
        <p>
          Para avisarle a la plataforma, <Link to="/unlock">desbloqueá tu wallet</Link>: el aviso sale solo.
        </p>
      )}
      {forged && reported === 'pending' && purpose === null && (
        <p>El aviso a la plataforma sale con tu próxima sesión de la wallet en esta pestaña.</p>
      )}
    </article>
  );
}
