// Pantalla cuando el arranque de seguridad falla: la app no opera (no hay formularios ni claves en esta pantalla) y
// explica qué hacer. El motivo ya se reportó al backend.
import type { BootFailure } from '../security/boot.ts';

const MESSAGES: Record<BootFailure, string> = {
  TRUSTED_TYPES_UNSUPPORTED: 'Este navegador no soporta Trusted Types. Actualizalo a su última versión.',
  TRUSTED_TYPES_NOT_ENFORCED: 'El sitio se sirvió sin exigir Trusted Types en su política de seguridad.',
  TRUSTED_TYPES_POLICY_TAKEN: 'Otro script tomó la política de seguridad de la app antes de que arrancara.',
};

export function SecurityBlocked({ failure }: { failure: BootFailure }) {
  return (
    <main className="shell__main">
      <section className="card card--danger" role="alert" aria-labelledby="blocked-title">
        <h1 id="blocked-title">MT Recovery no puede operar en estas condiciones</h1>
        <p>{MESSAGES[failure]}</p>
        <p>
          No ingreses tu Password R, no restaures claves ni conectes tu wallet en esta página. Cerrala y volvé a abrir
          la dirección oficial de MT Recovery; si el problema sigue, avisá a soporte.
        </p>
        <p className="muted">
          Código: <code>{failure}</code>
        </p>
      </section>
    </main>
  );
}
