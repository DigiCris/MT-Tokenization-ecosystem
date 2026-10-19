// Formulario de login de Recovery ([F-SES-01]): la misma cuenta que en Wallet, con su propia sesión en este listener.
// Con TOTP activo pide el código (o uno de recuperación). Se embebe en pantallas que no deben perder su estado (como el
// enrollment, que trae el pedido en memoria).
import { useCallback, useState } from 'react';
import { api } from '../app/services.ts';
import { useSessionStore } from '../session/context.tsx';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import { needsSecondFactor, signIn } from './account.ts';

/** Sólo rutas internas de la app (nunca una URL externa como destino después del login). */
export function safeReturnTo(value: string | null): string {
  return value !== null && /^\/(?!\/)[\w\-./?=&#%]*$/.test(value) ? value : '/';
}

/** Formulario de login (también embebido en pantallas que no deben perder su estado, como el enrollment). */
export function LoginForm({ onSignedIn }: { onSignedIn: () => void }) {
  const store = useSessionStore();
  const [needsSecond, setNeedsSecond] = useState(false);

  const login = useAsyncAction(
    useCallback(
      async (email: string, password: string, second: string) => {
        try {
          store.signedIn(await signIn(api, { email, password, second }));
          onSignedIn();
        } catch (error) {
          if (needsSecondFactor(error)) setNeedsSecond(true);
          throw error;
        }
      },
      [store, onSignedIn],
    ),
  );

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        void login.run(
          formValue(form, 'email').trim(),
          formValue(form, 'password'),
          needsSecond ? formValue(form, 'second').trim() : '',
        );
      }}
    >
      <Field label="Email" name="email" type="email" autoComplete="username" required />
      <Field label="Contraseña de cuenta" name="password" type="password" autoComplete="current-password" required />
      {needsSecond && (
        <Field
          label="Código de tu app de autenticación o de recuperación"
          name="second"
          autoComplete="one-time-code"
          required
        />
      )}
      {login.error && <Notice tone="error">{login.error}</Notice>}
      <button type="submit" className="button" disabled={login.pending}>
        {login.pending ? 'Ingresando…' : 'Iniciar sesión'}
      </button>
    </form>
  );
}
