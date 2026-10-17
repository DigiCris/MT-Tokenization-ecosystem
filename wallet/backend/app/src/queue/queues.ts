// Colas BullMQ y ruteo de eventos del outbox [B-Q-01]. La cola es sólo transporte (ADR-021): Postgres es la fuente
// de verdad y todo job lleva el id del evento de outbox que lo originó.
import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';

export const QUEUE_PREFIX = 'mtw';

export const QUEUES = {
  walletOperations: 'wallet-operations',
  email: 'email',
  notifications: 'notifications',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Evento de outbox → cola. Un evento sin ruta se rechaza al encolarlo (nunca queda atascado sin consumidor). */
export const EVENT_ROUTES: Readonly<Record<string, QueueName>> = {
  OPERATION_QUEUED: QUEUES.walletOperations,
  EMAIL_REQUESTED: QUEUES.email,
  NOTIFICATION_REQUESTED: QUEUES.notifications,
};

export function queueForEvent(eventType: string): QueueName | undefined {
  return Object.hasOwn(EVENT_ROUTES, eventType) ? EVENT_ROUTES[eventType] : undefined;
}

export interface OutboxJobData {
  outboxEventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}

/** jobId = id del agregado: deduplica mientras el job está pendiente; al completarse se borra (removeOnComplete). */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
};

/**
 * Ajustes por cola sobre DEFAULT_JOB_OPTIONS. Email: 8 intentos con espera exponencial desde 5 s (≈ 10,5 min en total,
 * dentro del TTL de 15 min de los códigos): una caída breve del proveedor no pierde el email.
 */
export const QUEUE_JOB_OPTIONS: Readonly<Record<QueueName, JobsOptions>> = {
  [QUEUES.walletOperations]: DEFAULT_JOB_OPTIONS,
  [QUEUES.email]: { ...DEFAULT_JOB_OPTIONS, attempts: 8, backoff: { type: 'exponential', delay: 5_000 } },
  [QUEUES.notifications]: DEFAULT_JOB_OPTIONS,
};

export type Queues = Readonly<Record<QueueName, Queue<OutboxJobData>>>;

/**
 * Colas de productor. `onError` recibe los errores de conexión (un EventEmitter sin listener de `error` tiraría el
 * proceso); el dispatcher ya registra cada publicación fallida.
 */
export function createQueues(connection: Redis, onError: (error: Error) => void): Queues {
  const make = (name: QueueName) => {
    const queue = new Queue<OutboxJobData>(name, {
      connection,
      prefix: QUEUE_PREFIX,
      defaultJobOptions: QUEUE_JOB_OPTIONS[name],
    });
    queue.on('error', onError);
    return queue;
  };
  return {
    [QUEUES.walletOperations]: make(QUEUES.walletOperations),
    [QUEUES.email]: make(QUEUES.email),
    [QUEUES.notifications]: make(QUEUES.notifications),
  } as Queues;
}

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.all(Object.values(queues).map((q) => q.close()));
}

/** waiting/active/delayed/failed por cola (métrica mtw_queue_jobs). */
export async function queueCounts(queues: Queues): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [name, queue] of Object.entries(queues)) {
    out[name] = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
  }
  return out;
}
