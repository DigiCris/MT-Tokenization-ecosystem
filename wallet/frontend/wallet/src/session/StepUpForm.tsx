// Formulario de step-up ([B-PSES-03]): pide el código por email para el scope y lo completa con el código (+ TOTP o
// código de recuperación si la cuenta tiene TOTP). KEY_RESTORE agrega la prueba de posesión que arma quien lo usa.
import { useCallback, useState } from 'react';
import type { StepUpScope } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import { useSession } from './context.tsx';
import { finishStepUp, startStepUp, type PendingStepUp, type StepUpCodes, type StepUpSession } from './step-up.ts';

const PURPOSE: Record<StepUpScope, string> = {
  ONBOARDING: 'crear tu wallet',
  U_REPLACEMENT: 'reemplazar tu clave de usuario',
  KEY_RESTORE: 'restaurar tu clave de usuario',
};

export function StepUpForm({
  scope,
  walletId,
  onSession,
  finish,
}: {
  scope: StepUpScope;
  walletId?: string;
  onSession: (session: StepUpSession) => void;
  /** Para KEY_RESTORE: completa el step-up con la prueba de posesión. */
  finish?: (pending: PendingStepUp, codes: StepUpCodes) => Promise<StepUpSession>;
}) {
  const { user } = useSession();
  const [pending, setPending] = useState<PendingStepUp | null>(null);
  const request = useAsyncAction(
    useCallback(async () => {
      setPending(await startStepUp(api, scope, walletId));
    }, [scope, walletId]),
  );
  const complete = useAsyncAction(
    useCallback(
      async (form: HTMLFormElement) => {
        if (pending === null) return;
        const second = formValue(form, 'second').trim();
        const codes: StepUpCodes = {
          code: formValue(form, 'code').trim(),
          ...(second === '' ? {} : /^\d{6}$/.test(second) ? { totp: second } : { recoveryCode: second }),
        };
        onSession(await (finish ?? ((p, c) => finishStepUp(api, p, c)))(pending, codes));
      },
      [finish, onSession, pending],
    ),
  );

  return (
    <article className="card stack" aria-labelledby={`step-up-${scope}`}>
      <h2 id={`step-up-${scope}`}>Confirmá que sos vos</h2>
      <p>Para {PURPOSE[scope]} te mandamos un código de 8 dígitos a tu email.</p>
      {pending === null ? (
        <>
          {request.error && <Notice tone="error">{request.error}</Notice>}
          <button type="button" className="button" disabled={request.pending} onClick={() => void request.run()}>
            {request.pending ? 'Enviando…' : 'Mandarme el código'}
          </button>
        </>
      ) : (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void complete.run(event.currentTarget);
          }}
        >
          <Notice>Te mandamos el código. Vence en 15 minutos.</Notice>
          <Field
            label="Código del email"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{8}"
            maxLength={8}
            required
          />
          {user?.totpEnabled === true && (
            <Field
              label="Código de tu app de autenticación o de recuperación"
              name="second"
              autoComplete="one-time-code"
              maxLength={11}
              required
            />
          )}
          {complete.error && (
            <p className="form__error" role="alert">
              {complete.error}
            </p>
          )}
          <button type="submit" className="button" disabled={complete.pending}>
            {complete.pending ? 'Confirmando…' : 'Confirmar'}
          </button>
          <button
            type="button"
            className="button button--ghost"
            disabled={request.pending}
            onClick={() => void request.run()}
          >
            Mandarme otro código
          </button>
        </form>
      )}
    </article>
  );
}
