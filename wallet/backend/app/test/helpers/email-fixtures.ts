// Parámetros fijos de cada plantilla de email (snapshots y envío real de cada plantilla por Mailgun).
import type { TemplateName, TemplateParams } from '../../src/email/templates.ts';

export const SAFE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const DESTINATION = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
export const OLD_KEY = '0x1111111111111111111111111111111111111111';
export const NEW_KEY = '0xab5801a7d398351b8be11c439e05c5b3259aec9b';
const ORIGIN = { ipPrefix: '203.0.113.0/24', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0' };
const AT = '2026-10-17T15:04:05.000Z';
const EXPIRES = '2026-10-17T15:19:05.000Z';

export const TEMPLATE_FIXTURES: { [K in TemplateName]: TemplateParams[K] } = {
  'email-verification': { code: '48213907', expiresAt: EXPIRES, origin: ORIGIN },
  'registration-attempt': { occurredAt: AT, origin: ORIGIN },
  'login-unlock': { code: '00912345', expiresAt: EXPIRES, origin: ORIGIN },
  'password-reset': {
    resetUrl:
      'https://wallet.example/reset-password#token=0192a0c4-1111-7000-8000-000000000001.c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3I',
    expiresAt: '2026-10-17T15:34:05.000Z',
    origin: ORIGIN,
  },
  'password-reset-completed': { occurredAt: AT, origin: ORIGIN },
  'new-login': { occurredAt: AT, origin: ORIGIN },
  'totp-enabled': { occurredAt: AT, origin: ORIGIN },
  'totp-disabled': { occurredAt: AT, origin: ORIGIN },
  'step-up-code': {
    code: '77441122',
    purpose: 'onboarding de la wallet',
    expiresAt: EXPIRES,
    origin: ORIGIN,
    safe: SAFE,
  },
  'whitelist-challenge': {
    code: '31415926',
    destination: DESTINATION,
    label: 'Cuenta de <script>alert(1)</script> Ana',
    safe: SAFE,
    expiresAt: EXPIRES,
    activationHours: 24,
    origin: ORIGIN,
  },
  'whitelist-activated': { destination: DESTINATION, label: 'Cuenta de Ana', safe: SAFE, occurredAt: AT },
  'whitelist-removed': { destination: DESTINATION, label: 'Cuenta de Ana', safe: SAFE, occurredAt: AT, removedBy: 'R' },
  'rotation-proposed': {
    role: 'U',
    oldKey: OLD_KEY,
    newKey: NEW_KEY,
    safe: SAFE,
    executableAt: '2026-10-19T15:04:05.000Z',
    occurredAt: AT,
    origin: ORIGIN,
  },
  'rotation-cancelled': { role: 'U', safe: SAFE, cancelledBy: 'R', occurredAt: AT },
  'rotation-executed': { role: 'S', oldKey: OLD_KEY, newKey: NEW_KEY, safe: SAFE, occurredAt: AT },
  'recovery-started': {
    safe: SAFE,
    action: 'reemplazo de la clave de usuario (U) con la clave de recuperación',
    occurredAt: AT,
    origin: ORIGIN,
  },
  'high-value-challenge': {
    code: '27182818',
    safe: SAFE,
    token: 'USDC',
    amount: '12.500,00',
    destination: DESTINATION,
    nonce: '42',
    expiresAt: EXPIRES,
    origin: ORIGIN,
  },
  'high-value-executed': {
    safe: SAFE,
    token: 'USDT',
    amount: '12.500,00',
    destination: DESTINATION,
    txHash: '0x9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0',
    occurredAt: AT,
  },
  'cooperation-paused': { app: 'WALLET', reason: 'el manifest servido no coincide con el firmado', occurredAt: AT },
};
