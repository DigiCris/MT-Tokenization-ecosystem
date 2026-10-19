// Enlace de regreso de Recovery abierto en una pestaña que no tiene el pedido (ninguna otra lo tomó: la del pedido se
// cerró o está en otro dispositivo). Esta pestaña no conoce el secreto `k` del pedido (ADR-033: vive sólo en la memoria
// de la pestaña que lo generó), así que el enlace no confirma nada acá (hallazgos N2 y N6 de la segunda revisión de
// P17.MAN). Sin `k`, además, no lo armó la app Recovery: se cancela ese pedido y se informa (N10). En los dos casos se
// ofrece generar un pedido nuevo, que obliga a crear otra R.
import { useEffect, useRef } from 'react';
import type { PlatformAuth } from '../api/request-signature.ts';
import { api } from '../app/services.ts';
import { Notice } from '../ui/forms.tsx';
import {
  BEFORE_NEW_REQUEST_TEXT,
  reportAbort,
  RETURN_LINK_ELSEWHERE_TEXT,
  ReturnLinkUnverifiedError,
  type RecoveryReturn,
} from './activation.ts';

export function ReturnedLinkCard({
  returned,
  platform,
  onNewRequest,
}: {
  returned: RecoveryReturn;
  platform: PlatformAuth;
  onNewRequest: () => void;
}) {
  const forged = returned.secret === null;
  const reported = useRef(false);
  useEffect(() => {
    if (!forged || reported.current) return;
    reported.current = true;
    void reportAbort(api, platform, returned.enrollmentId, 'RETURN_LINK_UNVERIFIED');
  }, [forged, platform, returned.enrollmentId]);

  return (
    <article className="card stack" aria-labelledby="return-title">
      <h2 id="return-title">Volviste desde la app Recovery</h2>
      {forged ? (
        <Notice tone="error">{new ReturnLinkUnverifiedError().message}</Notice>
      ) : (
        <Notice tone="warning">{RETURN_LINK_ELSEWHERE_TEXT}</Notice>
      )}
      <p>{BEFORE_NEW_REQUEST_TEXT}</p>
      <button type="button" className="button" onClick={onNewRequest}>
        Generar un pedido nuevo
      </button>
    </article>
  );
}
