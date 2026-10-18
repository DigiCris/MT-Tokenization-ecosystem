// Seguridad de la cuenta ([B-AUTH-05], [B-AUTH-06]): sesiones abiertas (listar, revocar una o todas las demás) y
// verificación en dos pasos (TOTP con QR propio en canvas, 10 códigos de recuperación que se muestran una sola vez,
// desactivar con la contraseña de cuenta y un código). Activar o desactivar TOTP rota la sesión: el cliente toma el
// CSRF nuevo de la respuesta.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { AccountSession } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { useSession, useSessionStore } from '../session/context.tsx';
import { downloadText } from '../ui/download.ts';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import { QrCanvas } from '../ui/QrCanvas.tsx';

const dateTime = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' });

export function SessionsPage() {
  const store = useSessionStore();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const load = useAsyncAction(
    useCallback(async () => {
      setSessions((await api.listSessions()).sessions);
    }, []),
  );
  useEffect(() => {
    void load.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sólo al montar
  }, []);
  const revoke = useAsyncAction(
    useCallback(
      async (session: AccountSession) => {
        await api.revokeSession(session.id);
        if (session.current) {
          await store.logout();
          await navigate('/login', { replace: true });
          return;
        }
        setSessions((await api.listSessions()).sessions);
      },
      [navigate, store],
    ),
  );
  const revokeOthers = useAsyncAction(
    useCallback(async () => {
      await api.revokeOtherSessions();
      setSessions((await api.listSessions()).sessions);
    }, []),
  );

  return (
    <section className="stack" aria-labelledby="sessions-title">
      <h1 id="sessions-title">Sesiones abiertas</h1>
      {load.error && <Notice tone="error">{load.error}</Notice>}
      {revoke.error && <Notice tone="error">{revoke.error}</Notice>}
      {sessions === null ? (
        <p role="status">Cargando sesiones…</p>
      ) : (
        <ul className="list" aria-label="Sesiones">
          {sessions.map((session) => (
            <li key={session.id} className="list__item">
              <div>
                <strong>{session.client === 'WALLET' ? 'Wallet' : 'Recovery'}</strong>
                {session.current && <span className="tag">Esta sesión</span>}
                <p className="muted">
                  {session.userAgent ?? 'Dispositivo desconocido'} · {session.ipPrefix ?? 'IP no disponible'}
                </p>
                <p className="muted">
                  Última actividad: {dateTime.format(new Date(session.lastSeenAt))} · Vence:{' '}
                  {dateTime.format(new Date(session.expiresAt))}
                </p>
              </div>
              <button
                type="button"
                className="button button--ghost"
                disabled={revoke.pending}
                onClick={() => void revoke.run(session)}
              >
                {session.current ? 'Cerrar esta sesión' : 'Revocar'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="button" disabled={revokeOthers.pending} onClick={() => void revokeOthers.run()}>
        Cerrar todas las demás sesiones
      </button>
      {revokeOthers.error && <Notice tone="error">{revokeOthers.error}</Notice>}
    </section>
  );
}

export function TotpPage() {
  const { user } = useSession();
  const store = useSessionStore();
  const [setup, setSetup] = useState<{ otpauthUri: string; secret: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const start = useAsyncAction(
    useCallback(async () => {
      setSetup(await api.totpSetup());
    }, []),
  );
  const enable = useAsyncAction(
    useCallback(
      async (form: HTMLFormElement) => {
        const { recoveryCodes: codes } = await api.totpEnable(formValue(form, 'code').trim());
        setRecoveryCodes(codes);
        setSetup(null);
        store.setUser(await api.me());
      },
      [store],
    ),
  );
  const disable = useAsyncAction(
    useCallback(
      async (form: HTMLFormElement) => {
        const code = formValue(form, 'code').trim();
        await api.totpDisable({
          password: formValue(form, 'password'),
          ...(/^\d{6}$/.test(code) ? { totp: code } : { recoveryCode: code }),
        });
        store.setUser(await api.me());
      },
      [store],
    ),
  );

  if (user === null) return null;
  return (
    <section className="stack narrow" aria-labelledby="totp-title">
      <h1 id="totp-title">Verificación en dos pasos</h1>
      {recoveryCodes !== null && (
        <article className="card" aria-labelledby="codes-title">
          <h2 id="codes-title">Códigos de recuperación</h2>
          <Notice tone="warning">
            Guardalos fuera de este dispositivo: se muestran una sola vez y cada uno sirve una vez si perdés la app.
          </Notice>
          <ol className="codes" aria-label="Códigos de recuperación">
            {recoveryCodes.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              downloadText('mtw-codigos-de-recuperacion.txt', `${recoveryCodes.join('\n')}\n`, 'text/plain');
            }}
          >
            Descargar los códigos
          </button>
        </article>
      )}
      {user.totpEnabled ? (
        <form
          className="card form"
          onSubmit={(event) => {
            event.preventDefault();
            void disable.run(event.currentTarget);
          }}
        >
          <Notice tone="success">La verificación en dos pasos está activa.</Notice>
          <Field
            label="Contraseña de cuenta"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <Field
            label="Código de la app o de recuperación"
            name="code"
            autoComplete="one-time-code"
            required
            maxLength={11}
          />
          {disable.error && (
            <p className="form__error" role="alert">
              {disable.error}
            </p>
          )}
          <button type="submit" className="button button--danger" disabled={disable.pending}>
            Desactivar verificación en dos pasos
          </button>
        </form>
      ) : setup === null ? (
        <article className="card">
          <p>
            Con la verificación en dos pasos, además de la contraseña de cuenta se pide un código de tu app de
            autenticación al iniciar sesión y en los pasos sensibles.
          </p>
          {start.error && <Notice tone="error">{start.error}</Notice>}
          <button type="button" className="button" disabled={start.pending} onClick={() => void start.run()}>
            Configurar
          </button>
        </article>
      ) : (
        <form
          className="card form"
          onSubmit={(event) => {
            event.preventDefault();
            void enable.run(event.currentTarget);
          }}
        >
          <p>Escaneá el código con tu app de autenticación o cargá la clave a mano.</p>
          <QrCanvas text={setup.otpauthUri} label="Código QR para la app de autenticación" />
          <p>
            Clave: <code data-testid="totp-secret">{setup.secret}</code>
          </p>
          <Field
            label="Código de 6 dígitos"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
          />
          {enable.error && (
            <p className="form__error" role="alert">
              {enable.error}
            </p>
          )}
          <button type="submit" className="button" disabled={enable.pending}>
            Activar
          </button>
        </form>
      )}
    </section>
  );
}
