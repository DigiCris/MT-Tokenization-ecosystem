// Link de regreso de Recovery ([F-LNK-02]): abre otra pestaña de la Wallet; esa pestaña le pasa `eid` y `r` a la que
// está activando Recovery por un BroadcastChannel del mismo origin (sólo datos públicos: la R se compara igual contra
// la que informa el backend) y, si ninguna responde, sigue ella misma.
export const RETURN_CHANNEL = 'mtw-recovery-return';

export interface ReturnMessage {
  type: 'recovery-return';
  enrollmentId: string;
  recoveryKey: string;
}

export interface AckMessage {
  type: 'recovery-ack';
  enrollmentId: string;
}

/** Ofrece el link de regreso a otra pestaña; true si alguna lo tomó. */
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

/** Escucha links de regreso para un enrollment; devuelve la función para dejar de escuchar. */
export function listenForReturn(enrollmentId: string, onReturn: (recoveryKey: string) => void): () => void {
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
    onReturn(data.recoveryKey);
  });
  return () => {
    channel.close();
  };
}
