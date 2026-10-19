// Step-up de Recovery ([B-PSES-03], [F-SES-02]): código por email (+ TOTP o código de recuperación si la cuenta lo
// tiene) → PlatformSession ENROLLMENT o RECOVERY de 15 min, atada a una session key P-256 nueva y no extraíble. Cada
// step-up revoca las PlatformSessions anteriores de la cuenta (el backend rota la sesión y su CSRF).
import { useCallback, useState } from 'react';
import type { StepUpScope } from '../api/recovery-api.ts';
import { api } from '../app/services.ts';
import { codeExpiryText, finishStepUp, startStepUp, stepUpFailure, type PendingStepUp } from '../auth/account.ts';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import { useSession, useSessionStore } from './context.tsx';
import type { PlatformSession } from './store.ts';

const SCOPE_TEXT: Record<StepUpScope, string> = {
  ENROLLMENT: 'registrar tu clave de recuperación',
  RECOVERY: 'firmar con tu clave de recuperación',
};

export function StepUp({
  scope,
  walletId,
  onSession,
}: {
  scope: StepUpScope;
  walletId?: string;
  onSession?: (session: PlatformSession) => void;
}) {
  const { user } = useSession();
  const store = useSessionStore();
  const [pending, setPending] = useState<PendingStepUp | null>(null);
  const [needsSecond, setNeedsSecond] = useState(user?.totpEnabled ?? false);

  const start = useAsyncAction(
    useCallback(async () => {
      setPending(await startStepUp(api, scope, walletId));
    }, [scope, walletId]),
  );

  const finish = useAsyncAction(
    useCallback(
      async (code: string, second: string) => {
        if (!pending) return;
        try {
          const session = await finishStepUp(api, pending, { code, second });
          store.setPlatform(session);
          onSession?.(session);
        } catch (error) {
          const failure = stepUpFailure(error);
          if (failure === 'SECOND_FACTOR') setNeedsSecond(true);
          // Con un TOTP incorrecto el código del email ya se usó: hay que pedir otro.
          if (failure === 'RESTART') setPending(null);
          throw error;
        }
      },
      [pending, store, onSession],
    ),
  );

  return (
    <section className="card stack" aria-labelledby="stepup-title">
      <h2 id="stepup-title">Verificá que sos vos</h2>
      <p>
        Para {SCOPE_TEXT[scope]} {pending ? 'te mandamos' : 'te vamos a mandar'} un código por email
        {needsSecond ? ' y te pedimos tu segundo factor' : ''}.{pending ? ` ${codeExpiryText(pending.expiresAt)}` : ''}{' '}
        La verificación dura 15 minutos.
      </p>
      {!pending ? (
        <>
          {start.error && <Notice tone="error">{start.error}</Notice>}
          <button type="button" className="button" disabled={start.pending} onClick={() => void start.run()}>
            {start.pending ? 'Enviando…' : 'Mandarme el código'}
          </button>
        </>
      ) : (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            void finish.run(formValue(form, 'code').trim(), needsSecond ? formValue(form, 'second').trim() : '');
          }}
        >
          <Field label="Código del email" name="code" inputMode="numeric" autoComplete="one-time-code" required />
          {needsSecond && (
            <Field
              label="Código de tu app de autenticación o de recuperación"
              name="second"
              autoComplete="one-time-code"
              required
            />
          )}
          {(finish.error ?? start.error) && <Notice tone="error">{finish.error ?? start.error}</Notice>}
          <button type="submit" className="button" disabled={finish.pending}>
            Confirmar
          </button>
        </form>
      )}
      {finish.error && !pending && (
        <button type="button" className="button button--secondary" onClick={() => void start.run()}>
          Pedir otro código
        </button>
      )}
    </section>
  );
}
