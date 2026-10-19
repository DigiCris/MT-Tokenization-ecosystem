// Hora de la cadena (timestamp del último bloque por el RPC propio): los contratos comparan madurez de rotaciones,
// activación de destinos y deadlines de swap contra block.timestamp, no contra el reloj del dispositivo. Para mostrar en
// el reloj del dispositivo un momento que decide la cadena (en el fork la cadena puede ir adelantada), se leen las dos
// horas juntas.
import { useEffect, useState } from 'react';
import type { BaseClient } from './client.ts';

export async function chainNowSeconds(reader: Pick<BaseClient, 'getBlock'>): Promise<bigint> {
  return (await reader.getBlock({ blockTag: 'latest' })).timestamp;
}

/** Hora de la cadena y del dispositivo (ms) leídas en el mismo momento. */
export interface ChainClock {
  chainMs: number;
  deviceMs: number;
}

/** Hora de la cadena junto con la del dispositivo, refrescadas cada 30 s (null hasta la primera lectura). */
export function useChainClock(reader: Pick<BaseClient, 'getBlock'>): ChainClock | null {
  const [clock, setClock] = useState<ChainClock | null>(null);
  useEffect(() => {
    const alive = { current: true };
    const read = () => {
      chainNowSeconds(reader)
        .then((seconds) => {
          if (alive.current) setClock({ chainMs: Number(seconds) * 1000, deviceMs: Date.now() });
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
  return clock;
}

/** Milisegundos de la hora de la cadena, refrescada cada 30 s (null hasta la primera lectura). */
export function useChainNow(reader: Pick<BaseClient, 'getBlock'>): number | null {
  return useChainClock(reader)?.chainMs ?? null;
}

/**
 * Hora del dispositivo (ms) que avanza cada `intervalMs` mientras `active` (cuentas regresivas que no esperan a la
 * próxima lectura de la cadena); null hasta el primer tic.
 */
export function useDeviceNow(active: boolean, intervalMs = 1_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [active, intervalMs]);
  return now;
}
