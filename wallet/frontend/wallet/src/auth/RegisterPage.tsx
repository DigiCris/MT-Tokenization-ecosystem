// Registro de cuenta ([B-AUTH-01]): email y contraseña de cuenta (no es la Password U). El backend responde igual exista
// o no la cuenta y manda un código de 8 dígitos al email; el email pasa a la pantalla siguiente por el estado de la
// navegación (nunca en la URL).
import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../app/services.ts';
import { AccountPasswordNotice, Field, formValue, useAsyncAction } from '../ui/forms.tsx';

export function RegisterPage() {
  const navigate = useNavigate();
  const [mismatch, setMismatch] = useState<string | null>(null);
  const submit = useAsyncAction(
    useCallback(
      async (form: HTMLFormElement) => {
        const email = formValue(form, 'email').trim();
        const password = formValue(form, 'password');
        if (password !== formValue(form, 'confirm')) {
          setMismatch('Las contraseñas no coinciden');
          return;
        }
        setMismatch(null);
        await api.register({
          email,
          password,
          locale: navigator.language.slice(0, 2).toLowerCase(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        await navigate('/verify-email', { state: { email, sent: true } });
      },
      [navigate],
    ),
  );

  return (
    <section className="stack narrow" aria-labelledby="register-title">
      <h1 id="register-title">Crear cuenta</h1>
      <AccountPasswordNotice />
      <form
        className="card form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit.run(event.currentTarget);
        }}
      >
        <Field label="Email" name="email" type="email" autoComplete="email" required maxLength={254} />
        <Field
          label="Contraseña de cuenta"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
          hint="Al menos 12 caracteres. No uses la Password U ni una contraseña común."
        />
        <Field
          label="Repetir contraseña de cuenta"
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
        <button type="submit" className="button" disabled={submit.pending} aria-busy={submit.pending}>
          {submit.pending ? 'Creando…' : 'Crear cuenta'}
        </button>
      </form>
      <p>
        ¿Ya tenés cuenta? <Link to="/login">Iniciá sesión</Link>.
      </p>
    </section>
  );
}
