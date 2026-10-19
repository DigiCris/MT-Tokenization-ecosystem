// Hora de la cadena (timestamp del último bloque por el RPC propio): la madurez de una rotación la decide el timelock
// con block.timestamp, no el reloj del dispositivo.
import { useEffect, useState } from 'react';
import type { ChainReader } from './client.ts';

export async function chainNowMs(reader: Pick<ChainReader, 'getBlock'>): Promise<number> {
  const block = await reader.getBlock({ blockTag: 'latest' });
  return Number(block.timestamp) * 1000;
}

/** La hora de la cadena, releída cada `intervalMs` (null hasta la primera lectura). */
export function useChainNow(reader: Pick<ChainReader, 'getBlock'>, intervalMs = 15_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () => {
      chainNowMs(reader)
        .then((value) => {
          if (alive) setNow(value);
        })
        .catch(() => undefined);
    };
    read();
    const timer = setInterval(read, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [reader, intervalMs]);
  return now;
}
