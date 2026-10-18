// Login de cuenta ([B-AUTH-02]): email y contraseña de cuenta; si la cuenta tiene TOTP, el mismo pedido lleva el código
// de 6 dígitos o un código de recuperación. Cuenta bloqueada → desbloqueo por email; email sin verificar → verificación.
import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError } from '../api/problem.ts';
import { api } from '../app/services.ts';
import { useSessionStore } from '../session/context.tsx';
import { AccountPasswordNotice, Field, formValue, useAsyncAction } from '../ui/forms.tsx';
import { afterSignIn } from './after-sign-in.ts';

type SecondFactor = 'none' | 'totp' | 'recovery';

export function LoginPage() {
  const navigate = useNavigate();
  const store = useSessionStore();
  const [factor, setFactor] = useState<SecondFactor>('none');
  const [blocked, setBlocked] = useState<'locked' | 'unverified' | null>(null);
  const [email, setEmail] = useState('');

  const login = useAsyncAction(
    useCallback(
      async (form: HTMLFormElement) => {
        const input = {
          email: formValue(form, 'email').trim(),
          password: formValue(form, 'password'),
          ...(factor === 'totp' ? { totp: formValue(form, 'totp').trim() } : {}),
          ...(factor === 'recovery' ? { recoveryCode: formValue(form, 'recoveryCode').trim() } : {}),
        };
        setEmail(input.email);
        setBlocked(null);
        try {
          const { user } = await api.login(input);
          store.signedIn(user);
          await navigate(await afterSignIn(store), { replace: true });
        } catch (error) {
          if (error instanceof ApiError) {
            if (error.code === 'TOTP_REQUIRED' && factor === 'none') setFactor('totp');
            if (error.code === 'ACCOUNT_LOCKED') setBlocked('locked');
            if (error.code === 'EMAIL_NOT_VERIFIED') setBlocked('unverified');
          }
          throw error;
        }
      },
      [factor, navigate, store],
    ),
  );

  return (
    <section className="stack narrow" aria-labelledby="login-title">
      <h1 id="login-title">Iniciar sesión</h1>
      <AccountPasswordNotice />
      <form
        className="card form"
        onSubmit={(event) => {
          event.preventDefault();
          void login.run(event.currentTarget);
        }}
      >
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field label="Contraseña de cuenta" name="password" type="password" autoComplete="current-password" required />
        {factor === 'totp' && (
          <>
            <Field
              label="Código de verificación en dos pasos"
              name="totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              hint="El código de 6 dígitos de tu app de autenticación."
            />
            <button
              type="button"
              className="button button--link"
              onClick={() => {
                setFactor('recovery');
              }}
            >
              Usar un código de recuperación
            </button>
          </>
        )}
        {factor === 'recovery' && (
          <>
            <Field label="Código de recuperación" name="recoveryCode" autoComplete="off" required maxLength={11} />
            <button
              type="button"
              className="button button--link"
              onClick={() => {
                setFactor('totp');
              }}
            >
              Usar el código de la app
            </button>
          </>
        )}
        {login.error && (
          <p className="form__error" role="alert">
            {login.error}
          </p>
        )}
        {blocked === 'locked' && (
          <p>
            <Link to="/account-unlock" state={{ email }}>
              Desbloquear mi cuenta con un código por email
            </Link>
          </p>
        )}
        {blocked === 'unverified' && (
          <p>
            <Link to="/verify-email" state={{ email }}>
              Verificar mi email
            </Link>
          </p>
        )}
        <button type="submit" className="button" disabled={login.pending}>
          {login.pending ? 'Ingresando…' : 'Iniciar sesión'}
        </button>
      </form>
      <p>
        <Link to="/forgot-password">Olvidé mi contraseña de cuenta</Link> · <Link to="/register">Crear cuenta</Link> ·{' '}
        <Link to="/restore" reloadDocument>
          Restaurar mi clave en este dispositivo
        </Link>
      </p>
    </section>
  );
}
