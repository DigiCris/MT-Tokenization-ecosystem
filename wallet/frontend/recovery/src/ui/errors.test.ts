// Errores para mostrar en Recovery: los códigos del backend pasan a textos de esta app (con el tiempo de espera si lo
// hay) y ningún texto del backend (título ni detalle) llega a la pantalla, tampoco en un conflicto o con un código que
// la app no conoce (revisión de seguridad de ADR-033); los errores propios de la app conservan su mensaje.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import { describeError } from './errors.ts';

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
    expect(describeError('texto')).toBe('Algo salió mal.');
  });
});
