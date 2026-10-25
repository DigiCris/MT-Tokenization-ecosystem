// Comprobación del dispositivo: estado de las protecciones del navegador verificadas al arrancar, contratos del sistema
// fijados en este build y medición de la derivación de clave (Argon2id con los parámetros reales de los sobres, en el
// worker cargado por la política de Trusted Types). Datos aleatorios: no se usa ninguna clave ni password del usuario.
import { useRef, useState } from 'react';
import { appConfig, systemContracts } from '../config/index.ts';
import { SYSTEM_ROLES } from '../config/system-contracts.ts';
import { ARGON2_BASELINE } from '../workers/argon2-protocol.ts';
import { runArgon2id } from '../workers/argon2-client.ts';
import { useSecurityStatus } from './security-status.ts';

/** Presupuesto de [F-KEY-03]: ≤ 3 s p95 en el perfil móvil de referencia (ADR-013). */
const BUDGET_MS = 3_000;

type Measurement =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'done'; ms: number; run: number }
  | { state: 'error'; message: string };

export function DeviceCheckPage() {
  const status = useSecurityStatus();
  const [measurement, setMeasurement] = useState<Measurement>({ state: 'idle' });
  const runs = useRef(0);

  const measure = () => {
    setMeasurement({ state: 'running' });
    const password = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    runArgon2id({ ...ARGON2_BASELINE, password, salt })
      .then(({ key, elapsedMs }) => {
        key.fill(0);
        runs.current += 1;
        setMeasurement({ state: 'done', ms: elapsedMs, run: runs.current });
      })
      .catch((error: unknown) => {
        setMeasurement({ state: 'error', message: error instanceof Error ? error.message : 'falló la derivación' });
      });
  };

  return (
    <section className="stack" aria-labelledby="device-title">
      <h1 id="device-title">Comprobar este dispositivo</h1>

      <article className="card" aria-labelledby="protections-title">
        <h2 id="protections-title">Protecciones del navegador</h2>
        <ul className="checklist">
          <li className="checklist__ok">Política de seguridad de contenido (CSP) y Trusted Types activas.</li>
          <li className="checklist__ok">
            {status.removedServiceWorkers === 0
              ? 'Sin service workers registrados.'
              : `Se desregistraron ${String(status.removedServiceWorkers)} service workers.`}
          </li>
          <li className="checklist__ok">Sin scripts de terceros: todo se sirve desde esta misma dirección web.</li>
        </ul>
      </article>

      <article className="card" aria-labelledby="kdf-title">
        <h2 id="kdf-title">Derivación de clave</h2>
        <p>
          Mide cuánto tarda este dispositivo en derivar la clave de un sobre (Argon2id,{' '}
          {ARGON2_BASELINE.memoryKiB / 1024} MiB, {ARGON2_BASELINE.iterations} pasadas, paralelismo{' '}
          {ARGON2_BASELINE.parallelism}).
        </p>
        <button
          type="button"
          className="button"
          onClick={measure}
          disabled={measurement.state === 'running'}
          aria-busy={measurement.state === 'running'}
        >
          {measurement.state === 'running' ? 'Midiendo…' : 'Medir derivación'}
        </button>
        <p
          className="result"
          role="status"
          aria-live="polite"
          data-elapsed-ms={measurement.state === 'done' ? String(Math.round(measurement.ms)) : undefined}
          data-run={measurement.state === 'done' ? String(measurement.run) : undefined}
        >
          {measurement.state === 'done' &&
            `${(measurement.ms / 1000).toFixed(2)} s — ${
              measurement.ms <= BUDGET_MS ? 'dentro del presupuesto de 3 s' : 'por encima del presupuesto de 3 s'
            }`}
          {measurement.state === 'error' && `No se pudo medir: ${measurement.message}`}
        </p>
      </article>

      <article className="card" aria-labelledby="contracts-title">
        <h2 id="contracts-title">Contratos del sistema fijados en este build</h2>
        <p>
          Entorno <strong>{appConfig.environment}</strong>, desplegados en el bloque {systemContracts.deploymentBlock}.
          Si el servidor informara otras direcciones, la app se niega a operar.
        </p>
        <dl className="contracts">
          {SYSTEM_ROLES.map((role) => (
            <div key={role} className="contracts__row">
              <dt>{systemContracts.contracts[role].name}</dt>
              <dd>
                <code>{systemContracts.contracts[role].address}</code>
              </dd>
            </div>
          ))}
        </dl>
      </article>
    </section>
  );
}
