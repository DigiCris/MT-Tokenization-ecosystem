// Marco común de las pantallas de Recovery: marca con su acento propio (el usuario tiene que saber en qué app está, V9
// §17), entorno (fuera de producción), la cuenta con su salida, el bloqueo de R y de la PlatformSession, el aviso de
// que falta un minuto para el bloqueo por inactividad (cuarta revisión de P17.MAN) y el release del build. El aviso
// queda pegado al borde de abajo de la ventana desde cualquier scroll: quien anota las 17 palabras o la Password R tiene
// la página corrida hacia abajo (N3 de la verificación); va al final del contenido, así que al llegar abajo no tapa nada.
import { Link, Outlet } from 'react-router';
import { appConfig } from '../config/index.ts';
import { useSession, useSessionStore } from '../session/context.tsx';
import { INACTIVITY_WARNING_TEXT, KEEP_USING_LABEL } from '../session/texts.ts';

export function AppShell() {
  const session = useSession();
  const store = useSessionStore();
  const unlocked = session.recovery !== null || session.external !== null || session.platform !== null;
  return (
    <div className="shell">
      <header className="shell__header">
        <Link to="/" className="brand" aria-label="MT Recovery, inicio">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">MT Recovery</span>
        </Link>
        <nav className="shell__nav" aria-label="Cuenta">
          {appConfig.environment !== 'production' && (
            <span className="env-badge" title="Entorno del build">
              {appConfig.environment}
            </span>
          )}
          {unlocked && (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                store.lock('MANUAL');
              }}
            >
              Bloquear
            </button>
          )}
          {session.status === 'account' && session.user ? (
            <span className="shell__account">
              <span data-account={session.user.email}>{session.user.email}</span>
              <button type="button" className="button button--link" onClick={() => void store.logout()}>
                Cerrar sesión
              </button>
            </span>
          ) : (
            session.status === 'anonymous' && <Link to="/login">Iniciar sesión</Link>
          )}
        </nav>
      </header>
      <main className="shell__main">
        <Outlet />
      </main>
      {session.inactivityWarning && (
        <div className="inactivity-warning">
          <div className="notice notice--warning stack" role="alert" data-inactivity-warning="">
            <p>{INACTIVITY_WARNING_TEXT}</p>
            <div className="actions">
              <button
                type="button"
                className="button"
                onClick={() => {
                  store.touch();
                }}
              >
                {KEEP_USING_LABEL}
              </button>
            </div>
          </div>
        </div>
      )}
      <footer className="shell__footer">
        <span>
          Release <code>{appConfig.releaseId}</code>
        </span>
        <a href="/licenses/fonts.txt">Licencias de las fuentes</a>
      </footer>
    </div>
  );
}
