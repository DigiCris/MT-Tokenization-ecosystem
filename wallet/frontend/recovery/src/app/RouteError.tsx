// Error inesperado al renderizar una ruta: mensaje genérico (sin detalles internos) y vuelta al inicio.
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';

export function RouteError() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : null;
  return (
    <main className="shell__main">
      <section className="card" aria-labelledby="route-error-title">
        <h1 id="route-error-title">Algo salió mal</h1>
        <p>
          {status === null
            ? 'La pantalla no pudo mostrarse.'
            : `La pantalla respondió con el estado ${String(status)}.`}
        </p>
        <Link className="button button--secondary" to="/">
          Ir al inicio
        </Link>
      </section>
    </main>
  );
}
