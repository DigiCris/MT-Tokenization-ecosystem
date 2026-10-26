// Desbloqueo (P17.T06, [F-SES-02]): el sobre (recordado, Drive o archivo) + la Password U → PlatformSession OPERATIONS
// de 15 minutos (UnlockForm). Opcionalmente recuerda el sobre cifrado en este dispositivo. Si toca el chequeo periódico
// del backup en Drive ([F-DRV-05]) se avisa después, sin bloquear el desbloqueo.
import { useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useSession } from '../session/context.tsx';
import { Notice } from '../ui/forms.tsx';
import { UnlockForm } from './UnlockForm.tsx';

const LOCK_MESSAGES = {
  INACTIVITY: 'La wallet se bloqueó tras 5 minutos sin actividad.',
  EXPIRED: 'La sesión de la wallet venció (15 minutos): desbloqueala de nuevo.',
  MANUAL: 'Bloqueaste la wallet.',
  LOGOUT: null,
} as const;

export function UnlockPage() {
  const { lastLock, wallet } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = ((location.state ?? {}) as { returnTo?: string }).returnTo ?? '/';
  const back = useCallback(async () => {
    await navigate(returnTo, { replace: true });
  }, [navigate, returnTo]);

  return (
    <section className="stack narrow" aria-labelledby="unlock-title">
      <h1 id="unlock-title">Desbloquear la wallet</h1>
      {lastLock !== null && LOCK_MESSAGES[lastLock] !== null && <Notice>{LOCK_MESSAGES[lastLock]}</Notice>}
      {wallet === null && (
        <Notice tone="warning">
          Todavía no tenés una wallet. <Link to="/onboarding">Creala</Link>.
        </Notice>
      )}
      <UnlockForm onUnlocked={back} />
    </section>
  );
}
