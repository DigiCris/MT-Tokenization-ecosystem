// [B-MAIL-01] Un 429 de Mailgun informa desde cuándo vuelve a aceptar envíos: header Retry-After (segundos o fecha
// HTTP) o "try again after <fecha>" en el mensaje (formato real de la cuota diaria del dominio sandbox, observado el
// 2026-10-17). El worker lo registra y los tests live lo usan para fallar en el acto con un motivo claro.
import { describe, expect, it } from 'vitest';
import { parseRetryAfter } from '../../src/email/mailgun.ts';

const NOW = Date.UTC(2026, 9, 17, 20, 48, 0);

describe('parseRetryAfter', () => {
  it('toma la fecha del mensaje de cuota diaria de Mailgun', () => {
    const message =
      'Domain sandbox0.mailgun.org is not allowed to send: daily request limit (100) exceeded, try again after Sun, 18 Oct 2026 17:28:42 UTC';
    expect(parseRetryAfter(null, message, NOW)?.toISOString()).toBe('2026-10-18T17:28:42.000Z');
  });

  it('prefiere el header Retry-After, en segundos o como fecha HTTP', () => {
    expect(parseRetryAfter('120', 'try again after Sun, 18 Oct 2026 17:28:42 UTC', NOW)?.getTime()).toBe(NOW + 120_000);
    expect(parseRetryAfter('Sun, 18 Oct 2026 01:00:00 GMT', undefined, NOW)?.toISOString()).toBe(
      '2026-10-18T01:00:00.000Z',
    );
  });

  it('sin información utilizable no inventa una fecha', () => {
    expect(parseRetryAfter(null, 'Too Many Requests', NOW)).toBeUndefined();
    expect(parseRetryAfter('', undefined, NOW)).toBeUndefined();
    expect(parseRetryAfter('no-es-fecha', { message: 'x' }, NOW)).toBeUndefined();
    expect(parseRetryAfter(null, 'try again after mañana UTC', NOW)).toBeUndefined();
  });
});
