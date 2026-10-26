// R interna (P19.T03): la app genera R ([F-KEY-01]) y la Password R de 5 palabras ([F-KEY-02]); el usuario las anota y
// confirma 2 al azar; R se sella en `R.enc` con Argon2id (worker) y queda desbloqueada en memoria (sobre + K_R no
// exportable; los bytes de R se borran). Después vienen los backups. En el paso de cifrado se elige si recordar el sobre
// cifrado en este dispositivo ([F-KEY-07], marcado por defecto como en la Wallet): se guarda recién al enviar la
// dirección (enrollment.ts, keepEnvelopeOnDevice). Desde que la Password R está a la vista, quien monta este paso sabe
// que hay una R en curso: si Recovery se bloquea antes de enviarla, se descarta y se avisa (cuarta revisión de P17.MAN).
// Un cifrado que termina después del bloqueo (el paso ya se desmontó) no vuelve a poner R en la sesión. Con R cifrada,
// quien monta el paso sabe su dirección: si Recovery se bloquea durante los backups, el aviso dice cuál destruir (N6).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import type { EnrollmentStatus, StorageFlags } from '../api/recovery-api.ts';
import { argon2 } from '../app/services.ts';
import { BackupStep } from '../backup/BackupStep.tsx';
import { NewPasswordR } from '../backup/NewPasswordR.tsx';
import { appConfig } from '../config/index.ts';
import { wipe } from '../crypto/encoding.ts';
import { sealRecoveryKey } from '../crypto/envelope.ts';
import { newPrivateKey } from '../crypto/secp256k1.ts';
import type { UnlockedRecovery } from '../crypto/session.ts';
import { useSessionStore } from '../session/context.tsx';
import { useAsyncAction } from '../ui/forms.tsx';
import { NEW_R_PER_REQUEST_TEXT, REMEMBER_R_LABEL, REPLACEMENT_NEW_R_PER_REQUEST_TEXT } from './texts.ts';

export function CreateRecoveryKey({
  walletId,
  purpose,
  onStarted,
  onCreated,
  onReady,
}: {
  walletId: string;
  /** En un reemplazo, la R actual sigue vigente: el aviso de «otra R» no le pide destruir sus backups. */
  purpose: EnrollmentStatus['purpose'];
  /** La Password R quedó a la vista: empezó una R nueva (lo que se anote desde acá es de ella). */
  onStarted: () => void;
  /** R quedó cifrada (antes de los backups, que llevan su dirección). */
  onCreated: (address: Address) => void;
  onReady: (result: { unlocked: UnlockedRecovery; flags: StorageFlags; remember: boolean }) => void;
}) {
  const store = useSessionStore();
  const [unlocked, setUnlocked] = useState<UnlockedRecovery | null>(null);
  const [remember, setRemember] = useState(true);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const seal = useAsyncAction(
    useCallback(
      async (words: string[]) => {
        const key = newPrivateKey();
        try {
          const opened = await sealRecoveryKey(
            key,
            words.join(' '),
            { platformId: appConfig.platformId, walletId, keyVersion: 1 },
            argon2,
          );
          // Recovery se bloqueó mientras se cifraba: esta R ya se descartó y no vuelve a la sesión.
          if (!mounted.current) return;
          store.unlockRecovery(opened);
          setUnlocked(opened);
          onCreated(opened.address);
        } finally {
          wipe(key);
        }
      },
      [walletId, store, onCreated],
    ),
  );

  if (unlocked) {
    return (
      <BackupStep
        unlocked={unlocked}
        onDone={(flags) => {
          onReady({ unlocked, flags, remember });
        }}
      />
    );
  }

  return (
    <section className="card stack" aria-labelledby="create-r-title">
      <h2 id="create-r-title">Crear tu clave de recuperación en este navegador</h2>
      <p>
        La app genera tu clave R y una Password R de 5 palabras. R nunca sale de este navegador sin cifrar y la
        plataforma no puede usarla.
      </p>
      <p>{purpose === 'REPLACEMENT' ? REPLACEMENT_NEW_R_PER_REQUEST_TEXT : NEW_R_PER_REQUEST_TEXT}</p>
      <NewPasswordR
        generateLabel="Generar mi clave R"
        confirmLabel="Confirmar y cifrar"
        pending={seal.pending}
        error={seal.error}
        keyAddress={null}
        onGenerated={onStarted}
        confirmOptions={
          <label className="check">
            <input
              type="checkbox"
              name="remember-r"
              checked={remember}
              onChange={(event) => {
                setRemember(event.currentTarget.checked);
              }}
            />{' '}
            {REMEMBER_R_LABEL}
          </label>
        }
        onConfirmed={(words) => void seal.run(words)}
      />
    </section>
  );
}
