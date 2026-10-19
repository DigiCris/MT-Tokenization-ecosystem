// `/onboarding/confirm-recovery#eid=<id>&r=<R>&k=<k>` ([F-LNK-02], ADR-033): enlace de regreso de la app Recovery (del
// onboarding o del reemplazo de R). Limpia el fragmento y le pasa `eid`, `r` (la dirección de R, nunca la clave) y `k` a
// la pestaña que está activando Recovery (BroadcastChannel del mismo origin): sólo esa pestaña conoce el `k` del pedido y
// decide. Muestra el resultado real que informa esa pestaña (confirmado, cancelado o sin red); si ninguna lo toma, esta
// pestaña no puede confirmar nada con el enlace y lo explica enseguida (ReturnedLinkCard).
import { useEffect, useState } from 'react';
import { Notice } from '../ui/forms.tsx';
import { parseRecoveryReturn } from './activation.ts';
import { ReturnedLinkCard } from './ReturnedLinkCard.tsx';
import { offerReturn, type ReturnOutcome } from './return-channel.ts';

/** Lo que pasó con el enlace en la pestaña del pedido, para la pestaña que lo abrió. */
const OUTCOME_TEXT: Record<
  Exclude<ReturnOutcome, 'none'>,
  { tone: 'success' | 'error' | 'warning' | 'info'; text: string }
> = {
  checking: {
    tone: 'info',
    text: 'La pestaña donde generaste el pedido está comprobando el enlace: volvé a la pestaña de la Wallet para ver el resultado.',
  },
  confirmed: {
    tone: 'success',
    text: 'Listo: la dirección de tu clave R quedó confirmada; volvé a la pestaña de la Wallet donde generaste el pedido para seguir.',
  },
  aborted: {
    tone: 'error',
    text: 'La pestaña donde generaste el pedido no aceptó este enlace y canceló el pedido: no coincide con lo que espera ese pedido. Volvé a la pestaña de la Wallet y generá un pedido nuevo. No abras enlaces de regreso que te lleguen por email o por chat.',
  },
  retry: {
    tone: 'warning',
    text: 'La pestaña donde generaste el pedido no pudo consultar a la plataforma para comprobar el enlace: revisá tu conexión, volvé a la pestaña de la Wallet y abrí este enlace otra vez (o confirmá la dirección a mano).',
  },
};

export function ConfirmRecoveryPage() {
  const [returned] = useState(() => {
    const parsed = parseRecoveryReturn(window.location.hash);
    window.history.replaceState(window.history.state, '', window.location.pathname);
    return parsed;
  });
  const [state, setState] = useState<'offering' | ReturnOutcome>('offering');

  useEffect(() => {
    if (!returned) return;
    let live = true;
    void offerReturn(returned, {
      onStatus: (status) => {
        if (live) setState(status);
      },
    }).then((outcome) => {
      if (live) setState(outcome);
    });
    return () => {
      live = false;
    };
  }, [returned]);

  if (!returned) return <Notice tone="error">El enlace de regreso de Recovery no es válido.</Notice>;
  if (state === 'offering') {
    return <Notice>Pasando la dirección de tu clave R a la pestaña donde generaste el pedido…</Notice>;
  }
  if (state === 'none') return <ReturnedLinkCard returned={returned} />;
  const { tone, text } = OUTCOME_TEXT[state];
  return (
    <section className="stack narrow" data-return-outcome={state}>
      <Notice tone={tone}>{text}</Notice>
    </section>
  );
}
