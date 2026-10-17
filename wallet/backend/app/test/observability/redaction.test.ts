// [B-OBS] Redacción en profundidad, truncado de IPs, enmascarado de emails y limpieza de strings libres.
import { describe, expect, it } from 'vitest';
import {
  isSensitiveKey,
  maskEmail,
  redact,
  REDACTED,
  scrubString,
  truncateIp,
} from '../../src/observability/redaction.ts';

describe('redacción', () => {
  it('redacta cada clave sensible de [B-OBS] en cualquier nivel de anidamiento', () => {
    const keys = [
      'password',
      'passwordU',
      'passwordR',
      'otp',
      'code',
      'token',
      'authorization',
      'cookie',
      'set-cookie',
      'x-platform-session',
      'x-session-signature',
      'privateKey',
      'secret',
      'mnemonic',
      'seed',
      'registrationRecord',
    ];
    for (const key of keys) {
      const deep = { a: [{ b: { [key]: 'CANARY-VALUE' } }] };
      expect(JSON.stringify(redact(deep))).not.toContain('CANARY-VALUE');
      expect(isSensitiveKey(key)).toBe(true);
    }
    expect(isSensitiveKey('sessionToken')).toBe(true);
    expect(isSensitiveKey('PASSWORD_PEPPER_V1')).toBe(true);
    expect(isSensitiveKey('client_secret')).toBe(true);
    expect(isSensitiveKey('operationId')).toBe(false);
  });

  it('no modifica el objeto original y conserva lo no sensible', () => {
    const original = { operationId: 'op-1', nested: { password: 'x' } };
    const out = redact(original) as { operationId: string; nested: { password: string } };
    expect(out.operationId).toBe('op-1');
    expect(out.nested.password).toBe(REDACTED);
    expect(original.nested.password).toBe('x');
  });

  it('trunca IPs (IPv4 /24, IPv6 /48) y enmascara emails', () => {
    expect(truncateIp('203.0.113.77')).toBe('203.0.113.0/24');
    expect(truncateIp('::ffff:198.51.100.9')).toBe('198.51.100.0/24');
    expect(truncateIp('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(truncateIp('::1')).toBe('0:0:0::/48');
    expect(truncateIp('no-es-ip')).toBe(REDACTED);
    expect(maskEmail('ana.perez@dominio.com')).toBe('a***@dominio.com');
    const out = redact({ email: 'ana@dominio.com', ip: '203.0.113.77', remoteAddress: '2001:db8::5' });
    expect(out).toEqual({ email: 'a***@dominio.com', ip: '203.0.113.0/24', remoteAddress: '2001:db8:0::/48' });
  });

  it('limpia credenciales en URLs y tokens Bearer/Basic dentro de strings libres', () => {
    const message =
      'connect postgres://mtw_app:s3cr3t-pw@db:5432/x failed; header Bearer abc.def.ghi and Basic dXNlcjpwYXNz';
    const clean = scrubString(message);
    expect(clean).not.toContain('s3cr3t-pw');
    expect(clean).not.toContain('abc.def.ghi');
    expect(clean).not.toContain('dXNlcjpwYXNz');
    expect(clean).toContain('postgres://mtw_app:[REDACTED]@db:5432/x');
  });

  it('serializa errores con mensaje y stack limpios, código y causa', () => {
    const cause = new Error('redis://:hunter2hunter2@valkey:6379 unreachable');
    const error = Object.assign(new Error('fallo con postgres://u:pw-secreto@h/db', { cause }), {
      code: 'ECONNREFUSED',
    });
    const out = JSON.stringify(redact({ err: error }));
    expect(out).not.toContain('pw-secreto');
    expect(out).not.toContain('hunter2hunter2');
    expect(out).toContain('ECONNREFUSED');
  });

  it('acota la profundidad y resume buffers', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).toContain('[TRUNCATED]');
    expect(redact({ data: Buffer.alloc(7) })).toEqual({ data: '[7 bytes]' });
  });
});
