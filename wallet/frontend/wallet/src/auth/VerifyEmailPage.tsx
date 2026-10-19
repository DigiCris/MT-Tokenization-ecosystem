// Verificación de email ([B-AUTH-01]): el código de 8 dígitos del email abre la sesión de cuenta (probar el control de
// la casilla equivale a iniciarla). Se puede pedir otro código.
import { useCallback, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api } from '../app/services.ts';
import { useSessionStore } from '../session/context.tsx';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import { afterSignIn } from './after-sign-in.ts';

export function VerifyEmailPage() {
  const navigate = useNavigate();
  const store = useSessionStore();
  const location = useLocation();
  const state = (location.state ?? {}) as { email?: string; sent?: boolean };
  const [resent, setResent] = useState(false);

  const verify = useAsyncAction(
    useCallback(
      async (form: HTMLFormElement) => {
        const { user } = await api.verifyEmail({
          email: formValue(form, 'email').trim(),
          code: formValue(form, 'code').trim(),
        });
        store.signedIn(user);
        await navigate(await afterSignIn(store), { replace: true });
      },
      [navigate, store],
    ),
  );
  const resend = useAsyncAction(
    useCallback(async (email: string) => {
      await api.resendVerification(email);
      setResent(true);
    }, []),
  );

  return (
    <section className="stack narrow" aria-labelledby="verify-title">
      <h1 id="verify-title">Verificá tu email</h1>
      {state.sent === true && (
        <Notice>Si el email es válido, te mandamos un código de 8 dígitos. Vence en 15 minutos.</Notice>
      )}
      <form
        className="card form"
        onSubmit={(event) => {
          event.preventDefault();
          void verify.run(event.currentTarget);
        }}
      >
        <Field label="Email" name="email" type="email" autoComplete="email" required defaultValue={state.email ?? ''} />
        <Field
          label="Código de verificación"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{8}"
          maxLength={8}
          required
        />
        {verify.error && (
          <p className="form__error" role="alert">
            {verify.error}
          </p>
        )}
        <button type="submit" className="button" disabled={verify.pending} aria-busy={verify.pending}>
          {verify.pending ? 'Verificando…' : 'Verificar'}
        </button>
        <button
          type="button"
          className="button button--ghost"
          disabled={resend.pending}
          aria-busy={resend.pending}
          onClick={(event) => {
            const form = event.currentTarget.form;
            if (form) void resend.run(formValue(form, 'email').trim());
          }}
        >
          Mandarme otro código
        </button>
        {resent && <Notice tone="success">Listo: si la cuenta existe, te llega un código nuevo.</Notice>}
        {resend.error && <Notice tone="error">{resend.error}</Notice>}
      </form>
    </section>
  );
}
