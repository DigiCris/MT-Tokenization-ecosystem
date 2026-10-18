import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <section className="card" aria-labelledby="not-found-title">
      <h1 id="not-found-title">Página no encontrada</h1>
      <p>La dirección no corresponde a ninguna pantalla de MT Recovery.</p>
      <Link className="button button--secondary" to="/">
        Ir al inicio
      </Link>
    </section>
  );
}
