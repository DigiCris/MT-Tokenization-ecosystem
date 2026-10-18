// Marco común de las pantallas de Recovery: marca con su acento propio (el usuario tiene que saber en qué app está, V9
// §17), entorno (fuera de producción) y release del build.
import { Link, Outlet } from 'react-router';
import { appConfig } from '../config/index.ts';

export function AppShell() {
  return (
    <div className="shell">
      <header className="shell__header">
        <Link to="/" className="brand" aria-label="MT Recovery, inicio">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">MT Recovery</span>
        </Link>
        {appConfig.environment !== 'production' && (
          <span className="env-badge" title="Entorno del build">
            {appConfig.environment}
          </span>
        )}
      </header>
      <main className="shell__main">
        <Outlet />
      </main>
      <footer className="shell__footer">
        <span>
          Release <code>{appConfig.releaseId}</code>
        </span>
        <a href="/licenses/fonts.txt">Licencias de las fuentes</a>
      </footer>
    </div>
  );
}
