// Inicio de Recovery: qué es la app y el acceso a la comprobación del dispositivo.
import { Link } from 'react-router';

export function HomePage() {
  return (
    <section className="card card--hero" aria-labelledby="home-title">
      <p className="eyebrow">Clave de recuperación · R</p>
      <h1 id="home-title">La llave de recuperación de tu wallet</h1>
      <p className="lead">
        MT Recovery guarda y usa tu clave de recuperación (R), separada de la app Wallet: otro origin, otros backups y
        otra password. Con R podés reemplazar una clave perdida, cancelar rotaciones que no pediste y, junto con tu
        clave de usuario (U), operar tu Safe sin la plataforma.
      </p>
      <ul className="facts">
        <li>
          R se cifra en tu dispositivo con tu Password R, distinta de tu Password U, y nunca se envía al servidor.
        </li>
        <li>También podés usar como R una wallet externa tuya (una cuenta EOA).</li>
        <li>R nunca mueve fondos sola: cualquier cambio de claves espera 48 h y se puede cancelar.</li>
      </ul>
      <div className="actions">
        <Link className="button button--secondary" to="/device-check">
          Comprobar este dispositivo
        </Link>
      </div>
    </section>
  );
}
