// `/login` de Recovery ([F-SES-01]): la misma cuenta que en Wallet, con su propia sesión en este listener (cookie de
// Recovery). La cuenta se crea y se administra en Wallet.
import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { appConfig } from '../config/index.ts';
import { LoginForm, safeReturnTo } from './LoginForm.tsx';

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const done = useCallback(() => {
    void navigate(safeReturnTo(params.get('returnTo')), { replace: true });
  }, [navigate, params]);
  return (
    <section className="card stack narrow" aria-labelledby="login-title">
      <h1 id="login-title">Iniciar sesión en Recovery</h1>
      <p className="muted">
        Usá la misma cuenta que en la app Wallet. Esta contraseña no es tu Password R: tu clave de recuperación nunca
        sale de este navegador.
      </p>
      <LoginForm onSignedIn={done} />
      <p className="muted">
        ¿No tenés cuenta o la olvidaste? Gestionala desde <a href={appConfig.walletOrigin}>la app Wallet</a>.
      </p>
    </section>
  );
}
