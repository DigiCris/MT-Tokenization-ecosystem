// `/onboarding/confirm-recovery#eid=<id>&r=<R>&k=<k>` ([F-LNK-02], ADR-033): enlace de regreso de la app Recovery.
// Limpia el fragmento y le pasa `eid`, `r` (la dirección de R, nunca la clave) y `k` a la pestaña que está activando
// Recovery (BroadcastChannel del mismo origin): sólo esa pestaña conoce el `k` del pedido y decide. Si ninguna lo toma,
// esta pestaña no puede confirmar nada con el enlace: sigue la creación y ofrece generar un pedido nuevo.
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

  if (!returned) return <Notice tone="error">El enlace de regreso de Recovery no es válido.</Notice>;
  if (state === 'offering') {
    return <Notice>Pasando la dirección de tu clave R a la pestaña donde estás creando tu wallet…</Notice>;
  }
  if (state === 'taken') {
    return (
      <Notice tone="success">
        Listo: volvé a la pestaña de la Wallet donde estás creando tu wallet; ahí se comprueba la dirección de tu clave
        R.
      </Notice>
    );
  }
  return <OnboardingPage returned={returned} />;
}
