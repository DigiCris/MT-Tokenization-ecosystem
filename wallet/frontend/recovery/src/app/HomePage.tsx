// Inicio de Recovery: qué es la app y los accesos a cada función de R. /restore y /sovereign se abren con navegación
// completa (la cámara sólo se habilita para esas rutas cargadas como documento).
import { Link } from 'react-router';

const ACTIONS: { to: string; title: string; text: string; document?: boolean }[] = [
  {
    to: '/recover-u',
    title: 'Recuperar mi clave de usuario (U)',
    text: 'Reemplazar U perdida por la U′ que registró la app Wallet: R propone y, a las 48 h, ejecuta.',
  },
  {
    to: '/rotations',
    title: 'Rotaciones pendientes',
    text: 'Ver los cambios de claves en curso en Base, cancelar los que no pediste y ejecutar los maduros.',
  },
  {
    to: '/emergency',
    title: 'Emergencia',
    text: 'Si alguien tiene tu clave U: quitar destinos, anular operaciones pendientes y revocar permisos.',
  },
  {
    to: '/migration',
    title: 'Migración excepcional',
    text: 'Mover tus fondos a la Safe nueva que aprobó la plataforma, verificada en Base.',
  },
  {
    to: '/restore',
    title: 'Restaurar mi clave R',
    text: 'En un dispositivo nuevo: desde Drive, el archivo cifrado, el QR o las 17 palabras.',
    document: true,
  },
  {
    to: '/sovereign',
    title: 'Modo soberano',
    text: 'Operar tu Safe con U y R sin la plataforma (funciona aunque la plataforma no exista más).',
    document: true,
  },
];

export function HomePage() {
  return (
    <div className="stack">
      <section className="card card--hero" aria-labelledby="home-title">
        <p className="eyebrow">Clave de recuperación · R</p>
        <h1 id="home-title">La llave de recuperación de tu wallet</h1>
        <p className="lead">
          MT Recovery usa tu clave de recuperación (R), separada de la app Wallet: otra dirección web, otros backups y
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
      <nav aria-label="Funciones de Recovery">
        <ul className="list">
          {ACTIONS.map((action) => (
            <li key={action.to} className="list__item">
              <h2>
                <Link to={action.to} reloadDocument={action.document === true}>
                  {action.title}
                </Link>
              </h2>
              <p className="muted">{action.text}</p>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
