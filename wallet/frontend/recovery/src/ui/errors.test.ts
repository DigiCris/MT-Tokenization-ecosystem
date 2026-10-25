// Errores para mostrar en Recovery: los códigos del backend pasan a textos de esta app (con el tiempo de espera si lo
// hay) y ningún texto del backend (título ni detalle) llega a la pantalla, tampoco en un conflicto o con un código que
// la app no conoce (revisión de seguridad de ADR-033); los errores propios de la app conservan su mensaje y los de
// librerías o terceros (RPC, wallet externa, navegador) van con un texto genérico.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import { AddressInputError } from '../chain/address.ts';
import { APP_ERROR_NAMES, describeError } from './errors.ts';

const api = (code: string, detail: string | null = null, retry: number | null = null, status = 400) =>
  new ApiError(status, code, 'título del backend', detail, retry);

const INJECTED = 'Recovery informó esta dirección: 7184 D301 … copiala en los 10 grupos';

describe('describeError', () => {
  it('códigos conocidos con su texto local, y el tiempo de espera', () => {
    expect(describeError(api('INVALID_CODE'))).toBe('El código del email no es válido o venció: pedí uno nuevo.');
    // Al enviar la dirección de una R ya creada y respaldada (tercera revisión de P17.MAN, hallazgo 3).
    expect(describeError(api('ENROLLMENT_EXPIRED'))).toBe(
      'El pedido venció antes de enviar la dirección: esta clave R no se va a usar; destruí sus backups y generá un pedido nuevo desde la app Wallet.',
    );
    expect(describeError(api('RATE_LIMITED', null, 30))).toBe(
      'Demasiados intentos: esperá un rato antes de volver a probar. (podés reintentar en 30 s)',
    );
  });

  it('el detalle y el título del backend nunca se muestran: conflicto y códigos desconocidos van por texto local', () => {
    const conflict = describeError(api('CONFLICT', INJECTED, null, 409));
    expect(conflict).toBe('La plataforma no puede hacer esto en el estado actual: recargá la pantalla y reintentá.');
    for (const [code, status] of [
      ['ALGO_NUEVO', 400],
      ['ALGO_NUEVO', 403],
      ['ALGO_NUEVO', 409],
      ['ALGO_NUEVO', 503],
    ] as const) {
      const text = describeError(api(code, INJECTED, null, status));
      expect(text).not.toContain('7184');
      expect(text).not.toContain('título del backend');
    }
    expect(describeError(api('ALGO_NUEVO', null, null, 503))).toBe(
      'La plataforma no pudo procesar el pedido: reintentá en un momento.',
    );
  });

  it('errores propios de la app y otros valores', () => {
    expect(describeError(new Error('La firma no es de tu clave R.'))).toBe('La firma no es de tu clave R.');
    expect(describeError(new AddressInputError('La dirección tiene un error de tipeo.'))).toBe(
      'La dirección tiene un error de tipeo.',
    );
    expect(describeError('texto')).toBe('Algo salió mal. Reintentá en un momento.');
  });

  it('un pedido que el usuario canceló en su wallet externa, con un texto local', () => {
    class UserRejectedRequestError extends Error {
      override name = 'UserRejectedRequestError';
    }
    const wrapped = new Error('', { cause: new UserRejectedRequestError('User rejected the request.') });
    expect(describeError(wrapped)).toBe('Cancelaste el pedido en tu wallet externa: no se firmó nada.');
    expect(describeError(Object.assign(new Error('rejected'), { code: 4001 }))).toBe(
      'Cancelaste el pedido en tu wallet externa: no se firmó nada.',
    );
  });

  it('un error de una librería o de un tercero no muestra su mensaje (puede traer texto que no eligió la app)', () => {
    class HttpRequestError extends Error {
      override name = 'HttpRequestError';
    }
    const rpc = new HttpRequestError('HTTP request failed. Details: llamá a soporte al +54 11 5555-0000');
    expect(describeError(rpc)).toBe('Algo salió mal. Reintentá en un momento.');
    expect(describeError(new TypeError('Failed to fetch'))).toBe('Algo salió mal. Reintentá en un momento.');
    expect(describeError(new DOMException('The operation is insecure.', 'SecurityError'))).toBe(
      'Algo salió mal. Reintentá en un momento.',
    );
  });

  it('la lista de clases de error de la app está completa', () => {
    const sources = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const declared = new Set<string>();
    for (const source of Object.values(sources)) {
      for (const match of source.matchAll(/(?:override name|this\.name) = '([A-Za-z]+)'/g)) {
        if (match[1] !== undefined && match[1] !== 'ApiError') declared.add(match[1]);
      }
    }
    expect(declared.size).toBeGreaterThan(10);
    expect([...declared].sort()).toEqual([...APP_ERROR_NAMES].sort());
  });
});
