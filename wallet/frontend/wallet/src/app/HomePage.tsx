// Inicio de Wallet: qué es la app y, según la sesión, el próximo paso (cuenta, crear la wallet, desbloquearla) o, con la
// wallet ACTIVE, desbloqueada y verificada por la app, la Safe operativa (P18.T03). Con sesión de cuenta, los avisos
// in-app (P15.T07) se ven también con la wallet bloqueada o todavía no operativa.
import { Link } from 'react-router';
import { OperatingHome } from '../home/OperatingHome.tsx';
import { NotificationsPanel } from '../notifications/NotificationsPanel.tsx';
import { SafeGate } from '../safe/SafeGate.tsx';
import { useSession, useSessionStore } from '../session/context.tsx';
import { AddressText } from '../ui/AddressText.tsx';

const STATUS_TEXT: Record<string, string> = {
  CREATING: 'Creación en curso: falta terminar el alta de tus claves.',
  DEPLOYING: 'Desplegando tu Safe en Base.',
  VERIFYING: 'Verificando tu Safe on-chain.',
  ACTIVE: 'Activa.',
  SOVEREIGN_MODIFIED: 'Modificada fuera de la plataforma (modo soberano).',
  MIGRATING: 'Migración excepcional en curso.',
  FAILED: 'La creación falló.',
};

export function HomePage() {
  const { status, user, wallet, unlocked } = useSession();
  const store = useSessionStore();
  if (status === 'account' && wallet?.status === 'ACTIVE') {
    const operating = <SafeGate>{(ctx) => <OperatingHome ctx={ctx} />}</SafeGate>;
    // Desbloqueada, el inicio operativo muestra los avisos junto con las alertas leídas de la cadena.
    if (unlocked) return operating;
    return (
      <div className="stack">
        <NotificationsPanel />
        {operating}
      </div>
    );
  }
  return (
    <div className="stack">
      {status === 'account' && <NotificationsPanel />}
      {status === 'account' && user && (
        <section className="card stack" aria-labelledby="wallet-title">
          <h1 id="wallet-title">Tu wallet</h1>
          {wallet === null ? (
            <>
              <p>Todavía no creaste tu wallet.</p>
              <Link className="button" to="/onboarding">
                Crear mi wallet
              </Link>
            </>
          ) : (
            <>
              <p>
                Estado: <strong>{STATUS_TEXT[wallet.status] ?? wallet.status}</strong>
              </p>
              {wallet.safe && (
                <p>
                  Safe: <code>{wallet.safe}</code>
                </p>
              )}
              {wallet.status === 'CREATING' && (
                <Link className="button" to="/onboarding">
                  Seguir con la creación
                </Link>
              )}
              {wallet.status !== 'CREATING' &&
                (unlocked ? (
                  <div className="actions">
                    <p role="status">
                      Wallet desbloqueada (dirección de tu clave U:{' '}
                      <AddressText address={unlocked.envelope.keyAddress} />
                      ).
                    </p>
                    <button type="button" className="button button--ghost" onClick={() => void store.lock('MANUAL')}>
                      Bloquear
                    </button>
                  </div>
                ) : (
                  <Link className="button" to="/unlock">
                    Desbloquear
                  </Link>
                ))}
            </>
          )}
        </section>
      )}
      <section className="card card--hero" aria-labelledby="home-title">
        <p className="eyebrow">Base · USDC · USDT</p>
        <h1 id="home-title">Tu wallet en Base, con tu clave en tu dispositivo</h1>
        <p className="lead">
          MT Wallet es una Safe con tres firmantes: tu clave de usuario (U), que nunca se envía a la plataforma; tu
          clave de recuperación (R), que vive en la app Recovery; y la clave de la plataforma (S), que sólo coopera
          dentro de las reglas on-chain. Ninguna parte puede mover tus fondos sola.
        </p>
        <ul className="facts">
          <li>U se cifra en tu dispositivo con tu Password U y sólo se descifra para firmar.</li>
          <li>Con U y R podés operar sin la plataforma (modo soberano).</li>
          <li>Los envíos van sólo a destinos de tu whitelist, activos 24 h después de confirmarlos.</li>
        </ul>
        <div className="actions">
          {status === 'anonymous' && (
            <>
              <Link className="button" to="/register">
                Crear cuenta
              </Link>
              <Link className="button button--secondary" to="/login">
                Iniciar sesión
              </Link>
            </>
          )}
          <Link className="button button--secondary" to="/device-check">
            Comprobar este dispositivo
          </Link>
        </div>
      </section>
    </div>
  );
}
