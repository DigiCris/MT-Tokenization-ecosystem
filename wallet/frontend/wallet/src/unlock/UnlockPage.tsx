// Desbloqueo (P17.T06, [F-SES-02]): el sobre (recordado, Drive o archivo) + la Password U → PlatformSession OPERATIONS
// de 15 minutos. Opcionalmente recuerda el sobre cifrado en este dispositivo. Si toca el chequeo periódico del backup en
// Drive ([F-DRV-05]) se avisa después, sin bloquear el desbloqueo.
import { useCallback, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api, argon2 } from '../app/services.ts';
import type { KeyEnvelope } from '../crypto/envelope.ts';
import { useSession, useSessionStore } from '../session/context.tsx';
import { rememberEnvelope } from '../storage/envelope-cache.ts';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import { EnvelopeSource } from './EnvelopeSource.tsx';
import { unlockWallet } from './unlock.ts';

const LOCK_MESSAGES = {
  INACTIVITY: 'La wallet se bloqueó tras 5 minutos sin actividad.',
  EXPIRED: 'La sesión de la wallet venció (15 minutos): desbloqueala de nuevo.',
  MANUAL: 'Bloqueaste la wallet.',
  LOGOUT: null,
} as const;

export function UnlockPage() {
  const store = useSessionStore();
  const { lastLock, wallet } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = ((location.state ?? {}) as { returnTo?: string }).returnTo ?? '/';
  const [envelope, setEnvelope] = useState<KeyEnvelope | null>(null);
  const [remember, setRemember] = useState(false);

  const unlock = useAsyncAction(
    useCallback(
      async (form: HTMLFormElement) => {
        if (envelope === null) return;
        const unlocked = await unlockWallet(api, envelope, formValue(form, 'passwordU'), argon2);
        if (remember) await rememberEnvelope(envelope);
        store.unlocked(unlocked);
        await navigate(returnTo, { replace: true });
      },
      [envelope, navigate, remember, returnTo, store],
    ),
  );

  return (
    <section className="stack narrow" aria-labelledby="unlock-title">
      <h1 id="unlock-title">Desbloquear la wallet</h1>
      {lastLock !== null && LOCK_MESSAGES[lastLock] !== null && <Notice>{LOCK_MESSAGES[lastLock]}</Notice>}
      {wallet === null && (
        <Notice tone="warning">
          Todavía no tenés una wallet. <Link to="/onboarding">Creala</Link>.
        </Notice>
      )}
      {envelope === null ? (
        <article className="card stack" aria-labelledby="envelope-title">
          <h2 id="envelope-title">Tu sobre cifrado</h2>
          <p>Elegí de dónde sale el sobre cifrado de tu clave.</p>
          <EnvelopeSource onEnvelope={setEnvelope} />
          <p>
            ¿Dispositivo nuevo y sin el sobre?{' '}
            <Link to="/restore" reloadDocument>
              Restaurá tu clave
            </Link>
            .
          </p>
        </article>
      ) : (
        <form
          className="card form"
          onSubmit={(event) => {
            event.preventDefault();
            void unlock.run(event.currentTarget);
          }}
        >
          <p className="muted">
            Clave <code>{envelope.keyAddress}</code>
          </p>
          <Field
            label="Password U"
            name="passwordU"
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            hint="Las 5 palabras, separadas por espacios. No es la contraseña de tu cuenta."
          />
          <label className="check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => {
                setRemember(event.currentTarget.checked);
              }}
            />
            Recordar el sobre cifrado en este dispositivo
          </label>
          {unlock.error && (
            <p className="form__error" role="alert">
              {unlock.error}
            </p>
          )}
          <button type="submit" className="button" disabled={unlock.pending}>
            {unlock.pending ? 'Desbloqueando…' : 'Desbloquear'}
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              setEnvelope(null);
            }}
          >
            Usar otro sobre
          </button>
        </form>
      )}
    </section>
  );
}
