// Inicio de Wallet: qué es la app y el acceso a la comprobación del dispositivo.
import { Link } from 'react-router';

export function HomePage() {
  return (
    <section className="card card--hero" aria-labelledby="home-title">
      <p className="eyebrow">Base · USDC · USDT</p>
      <h1 id="home-title">Tu wallet en Base, con tu clave en tu dispositivo</h1>
      <p className="lead">
        MT Wallet es una Safe con tres firmantes: tu clave de usuario (U), que nunca sale de este navegador; tu clave de
        recuperación (R), que vive en la app Recovery; y la clave de la plataforma (S), que sólo coopera dentro de las
        reglas on-chain. Ninguna parte puede mover tus fondos sola.
      </p>
      <ul className="facts">
        <li>U se cifra en tu dispositivo con tu Password U y sólo se descifra para firmar.</li>
        <li>Con U y R podés operar sin la plataforma (modo soberano).</li>
        <li>Los envíos van sólo a destinos de tu whitelist, activos 24 h después de confirmarlos.</li>
      </ul>
      <div className="actions">
        <Link className="button button--secondary" to="/device-check">
          Comprobar este dispositivo
        </Link>
      </div>
    </section>
  );
}
