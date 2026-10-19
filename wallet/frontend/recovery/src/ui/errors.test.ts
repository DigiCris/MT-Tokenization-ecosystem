// Errores para mostrar en Recovery: los códigos del backend pasan a textos en castellano (con el tiempo de espera si lo
// hay y el detalle de un conflicto), los errores propios de la app conservan su mensaje y lo demás es genérico.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import { describeError } from './errors.ts';

const api = (code: string, detail: string | null = null, retry: number | null = null) =>
  new ApiError(400, code, 'título', detail, retry);

describe('describeError', () => {
  it('códigos conocidos, con espera y conflictos con detalle', () => {
    expect(describeError(api('INVALID_CODE'))).toBe('El código del email no es válido o venció: pedí uno nuevo.');
    expect(describeError(api('RATE_LIMITED', null, 30))).toBe(
      'Demasiados intentos: esperá un rato antes de volver a probar. (podés reintentar en 30 s)',
    );
    expect(describeError(api('CONFLICT', 'la rotación ya se ejecutó'))).toBe('la rotación ya se ejecutó.');
  });

  it('un código desconocido muestra su detalle o el título; errores propios y otros valores', () => {
    expect(describeError(api('ALGO_NUEVO', 'detalle del backend'))).toBe('detalle del backend');
    expect(describeError(api('ALGO_NUEVO'))).toBe('título');
    expect(describeError(new Error('La firma no es de tu clave R.'))).toBe('La firma no es de tu clave R.');
    expect(describeError('texto')).toBe('Algo salió mal.');
  });
});
