// Enlace de regreso de Recovery ([F-LNK-02]): abre otra pestaña de la Wallet; esa pestaña le pasa `eid`, `r` y `k` a la
// que está activando Recovery por un BroadcastChannel del mismo origin (nunca a un servidor). La pestaña del pedido es la
// única que conoce su `k` (ADR-033): compara el del enlace y, sólo si coincide, la R contra la que informa el backend.
// Revisión de seguridad de ADR-033 (menores): la pestaña del pedido responde con el resultado real —primero
// «comprobando» y después confirmado, cancelado o «reintentar» (sin red)—, así la del enlace no dice «Listo» para un
// enlace falsificado o una R que no coincide.
export const RETURN_CHANNEL = 'mtw-recovery-return';

/** Resultado del enlace en la pestaña del pedido. */
export type ReturnResult = 'confirmed' | 'aborted' | 'retry';
export type ReturnStatus = 'checking' | ReturnResult;
/** Lo que sabe la pestaña del enlace: ninguna pestaña lo tomó, sigue comprobándose o el resultado. */
export type ReturnOutcome = 'none' | ReturnStatus;

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
  status: ReturnStatus;
}

const STATUSES: readonly string[] = ['checking', 'confirmed', 'aborted', 'retry'];

function isAck(data: unknown, enrollmentId: string): data is AckMessage {
  const ack = data as Partial<AckMessage> | null;
  return (
    typeof ack === 'object' &&
    ack !== null &&
    ack.type === 'recovery-ack' &&
    ack.enrollmentId === enrollmentId &&
    typeof ack.status === 'string' &&
    STATUSES.includes(ack.status)
  );
}

/**
 * Ofrece el enlace de regreso a la pestaña del pedido y espera su resultado: 'none' si ninguna lo tomó en
 * `ackTimeoutMs`; si una lo tomó, el resultado ('confirmed', 'aborted' o 'retry'), o 'checking' si no llegó en
 * `resultTimeoutMs`. `onStatus` recibe cada estado que informa la pestaña del pedido.
 */
export function offerReturn(
  message: Omit<ReturnMessage, 'type'>,
  options: { ackTimeoutMs?: number; resultTimeoutMs?: number; onStatus?: (status: ReturnStatus) => void } = {},
): Promise<ReturnOutcome> {
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(RETURN_CHANNEL);
    let resultTimer: ReturnType<typeof setTimeout> | null = null;
    const done = (outcome: ReturnOutcome) => {
      clearTimeout(ackTimer);
      if (resultTimer !== null) clearTimeout(resultTimer);
      channel.close();
      resolve(outcome);
    };
    const ackTimer = setTimeout(() => {
      done('none');
    }, options.ackTimeoutMs ?? 1_500);
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (!isAck(event.data, message.enrollmentId)) return;
      const { status } = event.data;
      options.onStatus?.(status);
      if (status !== 'checking') {
        done(status);
        return;
      }
      clearTimeout(ackTimer);
      resultTimer ??= setTimeout(() => {
        done('checking');
      }, options.resultTimeoutMs ?? 30_000);
    });
    channel.postMessage({ type: 'recovery-return', ...message } satisfies ReturnMessage);
  });
}

/**
 * Escucha enlaces de regreso para un enrollment: a uno bien formado le responde «comprobando» y después el resultado de
 * `onReturn`. Los mensajes mal formados o de otro enrollment se ignoran (sin respuesta). Devuelve cómo dejar de escuchar.
 */
export function listenForReturn(
  enrollmentId: string,
  onReturn: (recoveryKey: string, secret: string | null) => ReturnResult | Promise<ReturnResult>,
): () => void {
  const channel = new BroadcastChannel(RETURN_CHANNEL);
  let open = true;
  const ack = (status: ReturnStatus) => {
    if (open) channel.postMessage({ type: 'recovery-ack', enrollmentId, status } satisfies AckMessage);
  };
  channel.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data as Partial<ReturnMessage> | null;
    if (
      typeof data !== 'object' ||
      data === null ||
      data.type !== 'recovery-return' ||
      data.enrollmentId !== enrollmentId ||
      typeof data.recoveryKey !== 'string' ||
      !(data.secret === undefined || data.secret === null || typeof data.secret === 'string')
    ) {
      return;
    }
    ack('checking');
    // Si la comprobación misma falla (no debería: decide siempre), la pestaña del enlace no afirma nada.
    Promise.resolve()
      .then(() => onReturn(data.recoveryKey ?? '', typeof data.secret === 'string' ? data.secret : null))
      .then(ack, () => {
        ack('retry');
      });
  });
  return () => {
    open = false;
    channel.close();
  };
}
