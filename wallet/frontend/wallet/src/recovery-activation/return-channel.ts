// Enlace de regreso de Recovery ([F-LNK-02]): abre otra pestaña de la Wallet; esa pestaña le pasa `eid`, `r` y `k` a la
// que está activando Recovery por un BroadcastChannel del mismo origin (nunca a un servidor). La pestaña del pedido es la
// única que conoce su `k` (ADR-033): compara el del enlace y, sólo si coincide, la R contra la que informa el backend.
export const RETURN_CHANNEL = 'mtw-recovery-return';

export interface ReturnMessage {
  type: 'recovery-return';
  enrollmentId: string;
  recoveryKey: string;
  /** `k` del enlace de regreso (null si no lo trae). */
  secret: string | null;
}

export interface AckMessage {
  type: 'recovery-ack';
  enrollmentId: string;
}

/** Ofrece el enlace de regreso a otra pestaña; true si alguna lo tomó. */
export function offerReturn(message: Omit<ReturnMessage, 'type'>, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(RETURN_CHANNEL);
    const timer = setTimeout(() => {
      channel.close();
      resolve(false);
    }, timeoutMs);
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      const data = event.data as Partial<AckMessage> | null;
      if (data?.type === 'recovery-ack' && data.enrollmentId === message.enrollmentId) {
        clearTimeout(timer);
        channel.close();
        resolve(true);
      }
    });
    channel.postMessage({ type: 'recovery-return', ...message } satisfies ReturnMessage);
  });
}

/** Escucha enlaces de regreso para un enrollment; devuelve la función para dejar de escuchar. */
export function listenForReturn(
  enrollmentId: string,
  onReturn: (recoveryKey: string, secret: string | null) => void,
): () => void {
  const channel = new BroadcastChannel(RETURN_CHANNEL);
  channel.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data as Partial<ReturnMessage> | null;
    if (
      data?.type !== 'recovery-return' ||
      data.enrollmentId !== enrollmentId ||
      typeof data.recoveryKey !== 'string'
    ) {
      return;
    }
    channel.postMessage({ type: 'recovery-ack', enrollmentId } satisfies AckMessage);
    onReturn(data.recoveryKey, typeof data.secret === 'string' ? data.secret : null);
  });
  return () => {
    channel.close();
  };
}
