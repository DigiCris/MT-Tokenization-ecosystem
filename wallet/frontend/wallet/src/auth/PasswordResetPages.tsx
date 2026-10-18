// Olvido y reset de la contraseña de cuenta ([B-AUTH-04]) y desbloqueo de una cuenta bloqueada ([B-AUTH-08]). El
// enlace del email trae el token en el fragmento (no llega a ningún servidor); se lee y se borra de la URL al montar.
// Restablecer la contraseña de cuenta cierra todas las sesiones y NO toca la Password U ni la clave.
import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api } from '../app/services.ts';
import { useSessionStore } from '../session/context.tsx';
import { AccountPasswordNotice, Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const submit = useAsyncAction(
    useCallback(async (form: HTMLFormElement) => {
      await api.forgotPassword(formValue(form, 'email').trim());
      setSent(true);
    }, []),
  );
  return (
    <section className="stack narrow" aria-labelledby="forgot-title">
      <h1 id="forgot-title">Olvidé mi contraseña de cuenta</h1>
      <Notice tone="warning">
        Esto restablece sólo la contraseña de cuenta. <strong>No recupera tu Password U</strong>: si la perdiste, usá
        &quot;Perdí mi Password U&quot; desde Seguridad.
      </Notice>
      {sent ? (
        <Notice tone="success">
          Si la cuenta existe, te mandamos un enlace para restablecerla. Vence en 30 minutos.
        </Notice>
      ) : (
        <form
          className="card form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit.run(event.currentTarget);
          }}
        >
          <Field label="Email" name="email" type="email" autoComplete="email" required />
          {submit.error && (
            <p className="form__error" role="alert">
              {submit.error}
            </p>
          )}
          <button type="submit" className="button" disabled={submit.pending}>
            Mandarme el enlace
          </button>
        </form>
      )}
    </section>
  );
}

export function ResetPasswordPage() {
  const store = useSessionStore();
  // El token del fragmento se toma al montar y se borra de la barra y del historial.
  const [token] = useState<string | null>(() => new URLSearchParams(window.location.hash.slice(1)).get('token'));
  const [done, setDone] = useState(false);
  const [mismatch, setMismatch] = useState<string | null>(null);

  useEffect(() => {
    if (window.location.hash !== '') window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const submit = useAsyncAction(
    useCallback(
      async (form: HTMLFormElement) => {
        const newPassword = formValue(form, 'password');
        if (newPassword !== formValue(form, 'confirm')) {
          setMismatch('Las contraseñas no coinciden');
          return;
        }
        setMismatch(null);
        await api.resetPassword({ token: token ?? '', newPassword });
        await store.refresh();
        setDone(true);
      },
      [store, token],
    ),
  );

  return (
    <section className="stack narrow" aria-labelledby="reset-title">
      <h1 id="reset-title">Nueva contraseña de cuenta</h1>
      <AccountPasswordNotice />
      {done ? (
        <Notice tone="success">
          Listo: cambiaste la contraseña de cuenta y se cerraron todas las sesiones.{' '}
          <Link to="/login">Iniciá sesión</Link>.
        </Notice>
      ) : token === null ? (
        <Notice tone="error">
          El enlace no trae un token válido. <Link to="/forgot-password">Pedí uno nuevo</Link>.
        </Notice>
      ) : (
        <form
          className="card form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit.run(event.currentTarget);
          }}
        >
          <Field
            label="Contraseña de cuenta nueva"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
          <Field
            label="Repetir contraseña"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            error={mismatch}
          />
          {submit.error && (
            <p className="form__error" role="alert">
              {submit.error}
            </p>
          )}
          <button type="submit" className="button" disabled={submit.pending}>
            Guardar contraseña
          </button>
        </form>
      )}
    </section>
  );
}

export function AccountUnlockPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialEmail = ((location.state ?? {}) as { email?: string }).email ?? '';
  const [sent, setSent] = useState(false);
  const request = useAsyncAction(
    useCallback(async (email: string) => {
      await api.requestAccountUnlock(email);
      setSent(true);
    }, []),
  );
  const unlock = useAsyncAction(
    useCallback(
      async (form: HTMLFormElement) => {
        await api.unlockAccount({ email: formValue(form, 'email').trim(), code: formValue(form, 'code').trim() });
        await navigate('/login', { replace: true });
      },
      [navigate],
    ),
  );
  return (
    <section className="stack narrow" aria-labelledby="account-unlock-title">
      <h1 id="account-unlock-title">Desbloquear la cuenta</h1>
      <form
        className="card form"
        onSubmit={(event) => {
          event.preventDefault();
          void unlock.run(event.currentTarget);
        }}
      >
        <Field label="Email" name="email" type="email" autoComplete="email" required defaultValue={initialEmail} />
        <button
          type="button"
          className="button button--ghost"
          disabled={request.pending}
          onClick={(event) => {
            const form = event.currentTarget.form;
            if (form) void request.run(formValue(form, 'email').trim());
          }}
        >
          Mandarme el código de desbloqueo
        </button>
        {sent && <Notice tone="success">Si la cuenta está bloqueada, te llega un código de 8 dígitos.</Notice>}
        {request.error && <Notice tone="error">{request.error}</Notice>}
        <Field
          label="Código de desbloqueo"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{8}"
          maxLength={8}
          required
        />
        {unlock.error && (
          <p className="form__error" role="alert">
            {unlock.error}
          </p>
        )}
        <button type="submit" className="button" disabled={unlock.pending}>
          Desbloquear
        </button>
      </form>
    </section>
  );
}
