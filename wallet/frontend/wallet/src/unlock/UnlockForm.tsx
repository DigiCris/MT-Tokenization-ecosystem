// Formulario de desbloqueo (P17.T06, [F-SES-02]): el sobre (recordado, Drive o archivo) + la Password U → PlatformSession
// OPERATIONS de 15 minutos, y opcionalmente recordar el sobre en este dispositivo. Lo usan la pantalla de desbloqueo y,
// sin salir de ella, una pantalla con algo en curso que se perdería al navegar: el reemplazo de R mantiene el pedido a
// Recovery y su secreto `k` en memoria (N14 de la verificación de P17.MAN). Ahí (`inPlace`) no se ofrece nada que
// recargue la página: ni conectar Drive (sí traer el sobre si Drive ya está conectado) ni restaurar la clave.
import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { api, argon2 } from '../app/services.ts';
import type { KeyEnvelope } from '../crypto/envelope.ts';
import { useSessionStore } from '../session/context.tsx';
import { rememberEnvelope } from '../storage/envelope-cache.ts';
import { Field, formValue, useAsyncAction } from '../ui/forms.tsx';
import { EnvelopeSource } from './EnvelopeSource.tsx';
import { unlockWallet } from './unlock.ts';

export function UnlockForm({
  onUnlocked,
  inPlace = false,
}: {
  /** Después de desbloquear (p. ej. volver a la pantalla que lo pidió). */
  onUnlocked?: () => Promise<void> | void;
  /** En la pantalla que tiene algo en curso: nada que recargue la página. */
  inPlace?: boolean;
}) {
  const store = useSessionStore();
  const [envelope, setEnvelope] = useState<KeyEnvelope | null>(null);
  const [remember, setRemember] = useState(false);

  const unlock = useAsyncAction(
    useCallback(
      async (form: HTMLFormElement) => {
        if (envelope === null) return;
        const unlocked = await unlockWallet(api, envelope, formValue(form, 'passwordU'), argon2);
        if (remember) await rememberEnvelope(envelope);
        store.unlocked(unlocked);
        await onUnlocked?.();
      },
      [envelope, onUnlocked, remember, store],
    ),
  );

  if (envelope === null) {
    return (
      <article className="card stack" aria-labelledby="envelope-title">
        <h2 id="envelope-title">Tu sobre cifrado</h2>
        <p>Elegí de dónde sale el sobre cifrado de tu clave.</p>
        <EnvelopeSource onEnvelope={setEnvelope} allowDriveConnect={!inPlace} />
        {!inPlace && (
          <p>
            ¿Dispositivo nuevo y sin el sobre?{' '}
            <Link to="/restore" reloadDocument>
              Restaurá tu clave
            </Link>
            .
          </p>
        )}
      </article>
    );
  }
  return (
    <form
      className="card form"
      onSubmit={(event) => {
        event.preventDefault();
        void unlock.run(event.currentTarget);
      }}
    >
      <p className="muted">
        Sobre cifrado de la clave U con la dirección <code>{envelope.keyAddress}</code>
      </p>
      <Field
        label="Password U"
        name="passwordU"
        type="password"
        autoComplete="off"
        spellCheck={false}
        required
        hint="Las 5 palabras, separadas por espacios. No es la contraseña de tu cuenta."
      />
      <label className="check">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => {
            setRemember(event.currentTarget.checked);
          }}
        />
        Recordar el sobre cifrado en este dispositivo
      </label>
      {unlock.error && (
        <p className="form__error" role="alert">
          {unlock.error}
        </p>
      )}
      <button type="submit" className="button" disabled={unlock.pending} aria-busy={unlock.pending}>
        {unlock.pending ? 'Desbloqueando…' : 'Desbloquear'}
      </button>
      <button
        type="button"
        className="button button--ghost"
        onClick={() => {
          setEnvelope(null);
        }}
      >
        Usar otro sobre
      </button>
    </form>
  );
}
