// Conexiones a Valkey (protocolo Redis) con ioredis. BullMQ exige `maxRetriesPerRequest: null` en conexiones de
// workers; los productores fallan rápido (sin cola offline) para que el outbox registre el error y reintente.
import { Redis } from 'ioredis';

export type { Redis } from 'ioredis';

export type RedisRole = 'producer' | 'worker' | 'client';

/** `onError` recibe los errores de conexión (ioredis reintenta solo; sin listener los imprime por consola). */
export function createRedis(
  url: string,
  role: RedisRole,
  connectionName: string,
  onError?: (error: Error) => void,
): Redis {
  const redis = new Redis(url, {
    connectionName,
    maxRetriesPerRequest: role === 'worker' ? null : 3,
    enableOfflineQueue: role !== 'producer',
    connectTimeout: 10_000,
    lazyConnect: false,
  });
  redis.on('error', onError ?? (() => undefined));
  return redis;
}
