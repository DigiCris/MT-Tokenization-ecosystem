// Captura de la salida del logger (tests de canario): todo lo que pino escribe queda en memoria.
import { Writable } from 'node:stream';
import { createLogger, type Logger } from '../../src/observability/logger.ts';

export interface CapturedLogger {
  logger: Logger;
  output: () => string;
  lines: () => Record<string, unknown>[];
}

export function captureLogger(level = 'trace'): CapturedLogger {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({ level, service: 'test', destination });
  return {
    logger,
    output: () => chunks.join(''),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}
