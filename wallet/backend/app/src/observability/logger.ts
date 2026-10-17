// Logger pino (JSON) con redacción obligatoria [B-OBS].
//
// pino aplica `formatters.log` antes que los serializers: el formatter redacta en profundidad todo el objeto (salvo
// `req`/`res`, que tienen serializers propios y mínimos) y `hooks.logMethod` limpia los mensajes de texto
// (credenciales en URLs, tokens Bearer). Fastify usa este mismo logger para sus logs de request.
import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { redact, scrubString, truncateIp } from './redaction.ts';

export type { Logger } from 'pino';

export interface LoggerConfig {
  level: string;
  service: string;
  /** Destino alternativo (tests de canario). */
  destination?: DestinationStream;
}

interface RequestLike {
  id?: unknown;
  method?: string;
  url?: string;
  ip?: string;
  routeOptions?: { url?: string };
}

interface ReplyLike {
  statusCode?: number;
}

function stripQuery(url: string | undefined): string | undefined {
  return url?.split('?')[0];
}

export const requestSerializer = (req: RequestLike) => ({
  id: req.id,
  method: req.method,
  url: stripQuery(req.url),
  route: req.routeOptions?.url,
  ip: req.ip ? truncateIp(req.ip) : undefined,
});

export const replySerializer = (reply: ReplyLike) => ({ statusCode: reply.statusCode });

export function loggerOptions(config: Omit<LoggerConfig, 'destination'>): LoggerOptions {
  return {
    level: config.level,
    base: { service: config.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    serializers: {
      req: requestSerializer,
      res: replySerializer,
      // El formatter ya convirtió los errores en objetos redactados.
      err: (value: unknown) => value,
    },
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(object)) {
          out[key] = key === 'req' || key === 'res' ? value : redact(value, 0, key);
        }
        return out;
      },
    },
    hooks: {
      logMethod(args, method) {
        // Un Error como primer argumento: pino usaría su `message` crudo como msg; se pasa ya redactado.
        const [first, ...rest] = args as unknown[];
        if (first instanceof Error) {
          const message = typeof rest[0] === 'string' ? rest[0] : first.message;
          const tail = rest.slice(typeof rest[0] === 'string' ? 1 : 0);
          method.apply(this, [{ err: redact(first, 0, 'err') }, scrubString(message), ...tail] as Parameters<
            typeof method
          >);
          return;
        }
        const cleaned = args.map((arg: unknown) => (typeof arg === 'string' ? scrubString(arg) : arg));
        method.apply(this, cleaned as Parameters<typeof method>);
      },
    },
  };
}

export function createLogger(config: LoggerConfig): Logger {
  const options = loggerOptions(config);
  return config.destination ? pino(options, config.destination) : pino(options);
}
