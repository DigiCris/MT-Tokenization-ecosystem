// R interna (P19.T03): la app genera R ([F-KEY-01]) y la Password R de 5 palabras ([F-KEY-02]); el usuario las anota y
// confirma 2 al azar; R se sella en `R.enc` con Argon2id (worker) y queda desbloqueada en memoria (sobre + K_R no
// exportable; los bytes de R se borran). Después vienen los backups.
import { useCallback, useState } from 'react';
import type { StorageFlags } from '../api/recovery-api.ts';
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

export function CreateRecoveryKey({
  walletId,
  onReady,
}: {
  walletId: string;
  onReady: (result: { unlocked: UnlockedRecovery; flags: StorageFlags }) => void;
}) {
  const store = useSessionStore();
  const [unlocked, setUnlocked] = useState<UnlockedRecovery | null>(null);

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
          store.unlockRecovery(opened);
          setUnlocked(opened);
        } finally {
          wipe(key);
        }
      },
      [walletId, store],
    ),
  );

  if (unlocked) {
    return (
      <BackupStep
        unlocked={unlocked}
        onDone={(flags) => {
          onReady({ unlocked, flags });
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
      <NewPasswordR
        generateLabel="Generar mi clave R"
        confirmLabel="Confirmar y cifrar"
        pending={seal.pending}
        error={seal.error}
        onConfirmed={(words) => void seal.run(words)}
      />
    </section>
  );
}
