// Hora de la cadena (timestamp del último bloque por el RPC propio): los contratos comparan madurez de rotaciones,
// activación de destinos y deadlines de swap contra block.timestamp, no contra el reloj del dispositivo.
import { useEffect, useState } from 'react';
import type { BaseClient } from './client.ts';

export async function chainNowSeconds(reader: Pick<BaseClient, 'getBlock'>): Promise<bigint> {
  return (await reader.getBlock({ blockTag: 'latest' })).timestamp;
}

/** Milisegundos de la hora de la cadena, refrescada cada 30 s (null hasta la primera lectura). */
export function useChainNow(reader: Pick<BaseClient, 'getBlock'>): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const alive = { current: true };
    const read = () => {
      chainNowSeconds(reader)
        .then((seconds) => {
          if (alive.current) setNow(Number(seconds) * 1000);
        })
        .catch(() => undefined);
    };
    read();
    const timer = setInterval(read, 30_000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [reader]);
  return now;
}
