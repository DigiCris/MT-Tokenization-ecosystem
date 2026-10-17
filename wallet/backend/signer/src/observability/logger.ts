// Logger pino (JSON) del signer con redacción obligatoria. `operationId`, `walletId`, `safe` y `requestId` se loguean;
// nunca claves, credenciales, contraseñas derivadas ni tokens completos.
import { pino, type DestinationStream, type Logger } from 'pino';
import { redact, scrubString } from './redaction.ts';

export type { Logger } from 'pino';

export interface LoggerConfig {
  level: string;
  service: string;
  shardId?: string;
  destination?: DestinationStream;
}

export function createLogger(config: LoggerConfig): Logger {
  const options = {
    level: config.level,
    base: { service: config.service, ...(config.shardId === undefined ? {} : { shard: config.shardId }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    serializers: { err: (value: unknown) => value },
    formatters: {
      level: (label: string) => ({ level: label }),
      log: (object: Record<string, unknown>) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(object)) out[key] = redact(value, 0, key);
        return out;
      },
    },
    hooks: {
      logMethod(this: Logger, args: unknown[], method: (...a: unknown[]) => void) {
        // Un Error como primer argumento: pino usaría su `message` crudo como msg; se pasa ya redactado.
        const [first, ...rest] = args;
        if (first instanceof Error) {
          const message = typeof rest[0] === 'string' ? scrubString(rest[0]) : scrubString(first.message);
          method.apply(this, [{ err: redact(first) }, message, ...rest.slice(typeof rest[0] === 'string' ? 1 : 0)]);
          return;
        }
        method.apply(
          this,
          args.map((arg) => (typeof arg === 'string' ? scrubString(arg) : arg)),
        );
      },
    },
  };
  return config.destination ? pino(options, config.destination) : pino(options);
}
