// `/onboarding/confirm-recovery#eid=<id>&r=<R>` ([F-LNK-02]): link de regreso de la app Recovery. Limpia el fragmento,
// le pasa `eid` y `r` a la pestaña que está activando Recovery (BroadcastChannel) y, si ninguna lo toma, sigue la
// creación en esta pestaña (la R se compara igual contra la que informa la plataforma).
import { useEffect, useState } from 'react';
import { OnboardingPage } from '../onboarding/OnboardingPage.tsx';
import { Notice } from '../ui/forms.tsx';
import { parseRecoveryReturn } from './activation.ts';
import { offerReturn } from './return-channel.ts';

export function ConfirmRecoveryPage() {
  const [returned] = useState(() => {
    const parsed = parseRecoveryReturn(window.location.hash);
    window.history.replaceState(window.history.state, '', window.location.pathname);
    return parsed;
  });
  const [state, setState] = useState<'offering' | 'taken' | 'here'>('offering');

  useEffect(() => {
    if (!returned) return;
    void offerReturn(returned).then((taken) => {
      setState(taken ? 'taken' : 'here');
    });
  }, [returned]);

  if (!returned) return <Notice tone="error">El link de regreso de Recovery no es válido.</Notice>;
  if (state === 'offering') return <Notice>Pasando tu clave R a la pestaña donde estás creando tu wallet…</Notice>;
  if (state === 'taken') {
    return (
      <Notice tone="success">
        Listo: volvé a la pestaña de la Wallet donde estás creando tu wallet; tu clave R se está confirmando ahí.
      </Notice>
    );
  }
  return <OnboardingPage returned={returned} />;
}
