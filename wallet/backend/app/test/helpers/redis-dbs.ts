// Índice de base de Valkey propio por archivo de test: los archivos corren en paralelo y las colas de BullMQ (nombres
// fijos) o un FLUSHDB no se pueden compartir. El contenedor de test arranca con 64 bases (global-setup.ts); la 0 es la
// compartida por los listeners que sólo usan claves hasheadas por test (rate limit, riesgo de login).
export const REDIS_DBS = {
  outbox: 3,
  rateLimit: 5,
  entrypoint: 7,
  registerVerify: 8,
  sessions: 9,
  resetPassword: 10,
  totp: 11,
  bruteforceTotp: 12,
  otpReset: 13,
  authLogin: 14,
  csrf: 15,
  cookies: 16,
  emailDelivery: 17,
  securitySessions: 18,
  mailgunLive: 19,
  realDeliveryLive: 20,
  riskSignals: 21,
  riskUnit: 22,
} as const;
