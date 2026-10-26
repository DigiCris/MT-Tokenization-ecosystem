// Marco común de las pantallas de Wallet: marca, entorno (fuera de producción), sesión de cuenta (seguridad, bloquear,
// salir), aviso de pausa de la co-firma por integridad (P20.T03), aviso no bloqueante del chequeo periódico del backup
// en Drive ([F-DRV-05]), aviso un minuto antes del bloqueo por inactividad ([F-SES-04]) y release del build. El aviso
// de inactividad queda pegado al borde de abajo de la ventana desde cualquier scroll (N3 de la verificación de
// P17.MAN): va al final del contenido, así que al llegar abajo ocupa su lugar y no tapa nada.
import { useEffect, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router';
import { appConfig } from '../config/index.ts';
import { backupHealth } from '../drive/backup.ts';
import { api } from './services.ts';
import { useSession, useSessionStore } from '../session/context.tsx';
import { INACTIVITY_WARNING_TEXT, KEEP_USING_LABEL } from '../session/texts.ts';

const STATUS_POLL_MS = 60_000;

/** La plataforma pausó la co-firma de S (una app no pasó el control de integridad): aviso para el usuario. */
function useCooperationPaused(): boolean {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = () => {
      api
        .platformStatus()
        .then((status) => {
          if (alive) setPaused(status.cooperation === 'PAUSED');
        })
        .catch(() => undefined);
    };
    check();
    const timer = setInterval(check, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return paused;
}

export function AppShell() {
  const { status, user, unlocked, inactivityWarning } = useSession();
  const store = useSessionStore();
  const navigate = useNavigate();
  const health = status === 'account' ? backupHealth() : null;
  const cooperationPaused = useCooperationPaused();

  return (
    <div className="shell">
      <header className="shell__header">
        <Link to="/" className="brand" aria-label="MT Wallet, inicio">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">MT Wallet</span>
        </Link>
        <div className="shell__account">
          {appConfig.environment !== 'production' && (
            <span className="env-badge" title="Entorno del build">
              {appConfig.environment}
            </span>
          )}
          {status === 'account' && user && (
            <nav className="account-nav" aria-label="Cuenta">
              <span className="muted">{user.email}</span>
              <Link to="/security">Seguridad</Link>
              {unlocked && (
                <button type="button" className="button button--link" onClick={() => void store.lock('MANUAL')}>
                  Bloquear
                </button>
              )}
              <button
                type="button"
                className="button button--link"
                onClick={() => {
                  void store.logout().then(() => navigate('/login'));
                }}
              >
                Salir
              </button>
            </nav>
          )}
        </div>
      </header>
      {cooperationPaused && (
        <div className="banner banner--danger" role="alert">
          La plataforma pausó la co-firma de operaciones: una de sus apps no pasó el control de integridad. Tus fondos
          siguen en tu Safe y nadie puede moverlos sin tu clave U. Hasta nuevo aviso, no ingreses tu Password U ni tus
          palabras en ninguna página de la plataforma; si necesitás mover fondos, podés hacerlo sin ella con tus claves
          U y R y la herramienta de salida soberana, que corre en tu computadora.
        </div>
      )}
      {health?.due === true && (
        <div className="banner" role="status">
          {health.status === 'ok' || health.status === 'unknown'
            ? 'Toca verificar que el backup de tu clave siga en Google Drive.'
            : 'El backup de tu clave en Google Drive falta o no coincide.'}{' '}
          <Link to="/security">Revisarlo</Link>
        </div>
      )}
      <main className="shell__main">
        <Outlet />
      </main>
      {inactivityWarning && (
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
