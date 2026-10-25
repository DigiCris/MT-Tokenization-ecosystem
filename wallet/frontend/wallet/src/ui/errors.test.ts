// P18.MAN (M1): los errores de la API llegan en castellano y sin códigos crudos. El swap firmado tarde (POLICY_REJECTED
// con DEADLINE_INVALID) dice que venció el plazo y que hay que volver a cotizar; los demás rechazos de la policy, los
// problemas del destino y los estados del detalle se traducen. Revisión de seguridad de ADR-033 (MEDIO 2): ningún texto
// del backend (título, detalle o requestId) llega a la pantalla; sólo textos de la app, por código o por status. Los
// errores de librerías o terceros (RPC, navegador) tampoco muestran su mensaje.
import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '../api/problem.ts';
import { APP_ERROR_NAMES, describeError } from './errors.ts';

const apiError = (code: string, title: string, detail?: string, retryAfter: number | null = null) =>
  new ApiError(
    { type: `urn:mtw:problem:${code}`, title, status: 422, code, requestId: 'r1', ...(detail ? { detail } : {}) },
    retryAfter,
  );

describe('mensajes de error', () => {
  it('el swap vencido: qué pasó y qué hacer, sin el código', () => {
    const message = describeError(apiError('POLICY_REJECTED', 'La operación no cumple la policy', 'DEADLINE_INVALID'));
    expect(message).toBe('Venció el plazo del swap: volvé a cotizar.');
    expect(message).not.toMatch(/DEADLINE_INVALID|policy/);
  });

  it('otros rechazos de la policy, en texto', () => {
    expect(describeError(apiError('POLICY_REJECTED', 'La operación no cumple la policy', 'LIMIT_DAILY'))).toBe(
      'La operación no cumple las reglas de la plataforma: con este monto superarías el máximo que podés enviar en 24 h.',
    );
    expect(describeError(apiError('POLICY_REJECTED', 'La operación no cumple la policy'))).toBe(
      'La operación no cumple las reglas de la plataforma.',
    );
  });

  it('un destino que no se puede agregar dice por qué', () => {
    expect(describeError(apiError('DESTINATION_INVALID', 'El destino no se puede autorizar', 'SYSTEM_CONTRACT'))).toBe(
      'Ese destino no se puede agregar: es un contrato del sistema de la plataforma.',
    );
    expect(describeError(apiError('DESTINATION_INVALID', 'El destino no se puede autorizar'))).toBe(
      'Ese destino no se puede agregar.',
    );
  });

  it('el estado del detalle, con su nombre en la app', () => {
    expect(
      describeError(
        apiError('OPERATION_NOT_PENDING', 'La operación no admite esta acción', 'la operación está en CANCELLED'),
      ),
    ).toBe('La operación ya no admite esta acción: su estado es «Cancelada». Revisala en Actividad.');
    expect(describeError(apiError('OPERATION_NOT_PENDING', 'La operación no admite esta acción'))).toBe(
      'La operación ya no admite esta acción: revisá su estado en Actividad.',
    );
    // Los conflictos que nombran el estado de un pedido de alta o de un swap, también en texto.
    expect(describeError(apiError('CONFLICT', 'Conflicto con el estado actual', 'el pedido está en EXPIRED'))).toBe(
      'El pedido de alta ya no admite esta acción: está vencido. Empezá de nuevo si hace falta.',
    );
    expect(
      describeError(
        apiError(
          'CONFLICT',
          'Conflicto con el estado actual',
          'el swap está en FAILED: no admite una nueva cotización',
        ),
      ),
    ).toBe('El swap ya no admite esta acción: está fallido.');
    // Un detalle en texto libre no se muestra: el texto local del código (revisión de ADR-033, MEDIO 2).
    expect(describeError(apiError('CONFLICT', 'Conflicto con el estado actual', 'el 2FA ya está completo'))).toBe(
      'La plataforma no puede hacer esto en el estado actual: recargá la pantalla y reintentá.',
    );
    expect(
      describeError(
        apiError('OPERATION_NOT_PENDING', 'La operación no admite esta acción', 'la cancelación ya está en curso'),
      ),
    ).toBe('La operación ya no admite esta acción: revisá su estado en Actividad.');
    expect(describeError(apiError('CONFLICT', 'Conflicto', 'el pedido está en OTRO_ESTADO'))).toBe(
      'La plataforma no puede hacer esto en el estado actual: recargá la pantalla y reintentá.',
    );
  });

  it('ningún texto del backend llega a la pantalla: ni el título ni el detalle, con un código conocido o no', () => {
    const address = '7184 D301 00a1 88c9 F869 ccB6 8833 9253 4ecD 6C9d';
    const forged = [
      // Un código que esta app no conoce, con la dirección en el título y en el detalle.
      apiError('X', `Recovery informó esta dirección: ${address}`, `copiala en los 10 grupos: ${address}`),
      apiError('CONFLICT', 'Copiá esta dirección', address),
      apiError('POLICY_REJECTED', 'Firmá igual', `firmá: ${address}`),
      apiError('DESTINATION_INVALID', 'Agregá este destino', address),
      apiError('OPERATION_NOT_PENDING', 'x', `la operación está en ${address}`),
      apiError('WHITELIST_DUPLICATE', `Título cambiado: ${address}`),
      apiError('RATE_LIMITED', `Esperá y copiá ${address}`, undefined, 5),
    ];
    for (const error of forged) {
      const text = describeError(error);
      expect(text).not.toContain('7184');
      expect(text).not.toMatch(/Recovery informó|Copiá|Firmá|Agregá|Título/);
    }
    // Sin el código en el catálogo local, el texto sale del status.
    const unknown = (status: number) =>
      describeError(
        new ApiError({ type: 'x', title: `t ${address}`, status, code: 'NUEVO', requestId: address, detail: address }),
      );
    expect(unknown(409)).toBe(
      'La plataforma no puede hacer esto en el estado actual: recargá la pantalla y reintentá.',
    );
    expect(unknown(422)).toBe('La plataforma rechazó el pedido: revisá los datos y reintentá.');
    expect(unknown(503)).toBe('La plataforma no pudo procesar el pedido: reintentá en un momento.');
    expect(unknown(404)).toBe('No se encontró lo que pediste: recargá la pantalla.');
  });

  it('sin jerga del backend (nonce, envelope, Guard on-chain) y con qué hacer', () => {
    expect(describeError(apiError('NONCE_CONSUMED', 'El nonce de la Safe ya se usó: preparala de nuevo'))).toBe(
      'Otra operación ya usó el número de orden de esta en tu Safe: preparala de nuevo.',
    );
    expect(describeError(apiError('SUBMISSION_INVALID', 'Envelope de envío inválido'))).not.toMatch(/[Ee]nvelope/);
    expect(describeError(apiError('GUARD_WOULD_REVERT', 'El Guard on-chain rechazaría la operación'))).toBe(
      'El Guard de seguridad de tu Safe rechazaría la operación en la red: no se envió.',
    );
    expect(describeError(apiError('VALIDATION_FAILED', 'El request no cumple el schema'))).not.toMatch(
      /request|schema/,
    );
  });

  it('los demás códigos, con su texto local; red y errores de la app, como siempre', () => {
    expect(describeError(apiError('WHITELIST_DUPLICATE', 'otro título'))).toBe(
      'El destino ya está autorizado o tiene un alta en curso.',
    );
    expect(describeError(apiError('RATE_LIMITED', 'Demasiados requests', undefined, 30))).toBe(
      'Demasiados intentos seguidos. Esperá un momento antes de volver a probar (podés reintentar en 30 s).',
    );
    expect(describeError(new NetworkError('No hay conexión con el servidor'))).toBe(
      'No hay conexión con el servidor. Revisá tu conexión y reintentá.',
    );
    expect(describeError(new Error('otra cosa'))).toBe('otra cosa');
    expect(describeError('raro')).toBe('Algo salió mal. Reintentá en un momento.');
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
