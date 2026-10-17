// Captura en memoria de todo lo que escribe el logger (tests de canario: nada sensible en los logs).
import { Writable } from 'node:stream';
import { createLogger, type Logger } from '../../src/observability/logger.ts';

export interface CapturedLogger {
  logger: Logger;
  output: () => string;
}

export function captureLogger(level = 'trace'): CapturedLogger {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { logger: createLogger({ level, service: 'signer-test', destination }), output: () => chunks.join('') };
}
