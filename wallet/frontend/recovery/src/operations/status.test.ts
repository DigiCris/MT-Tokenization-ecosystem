// Tercera revisión independiente (revisión de seguridad de ADR-033): el estado, el tipo y el motivo de una operación
// van con textos de Recovery. Un estado o un tipo que esta app no conoce va en genérico; de un motivo desconocido sólo
// sale el código interno si tiene la forma de un código, y el detalle libre que agrega el backend nunca se muestra.
import { describe, expect, it } from 'vitest';
import type { OperationState } from '../api/recovery-api.ts';
import {
  internalCode,
  operationReasonText,
  operationTypeText,
  STATE_TEXT,
  stateText,
  UNKNOWN_OPERATION_TEXT,
  UNKNOWN_STATE_TEXT,
} from './status.ts';

describe('textos de las operaciones', () => {
  it('cada estado del pipeline tiene texto; uno desconocido (o una clave del prototipo), el genérico', () => {
    for (const state of Object.keys(STATE_TEXT) as OperationState[]) expect(stateText(state)).toBe(STATE_TEXT[state]);
    expect(stateText('CREATED')).toBe('Esperando la firma de R');
    for (const raw of ['ESTADO_NUEVO', 'constructor', '__proto__', 'Firmá en evil.example']) {
      expect(stateText(raw)).toBe(UNKNOWN_STATE_TEXT);
    }
  });

  it('el tipo de operación en texto; uno desconocido, el genérico', () => {
    expect(operationTypeText('NOOP_CANCEL')).toBe('Cancelación');
    expect(operationTypeText('WHITELIST_REMOVE')).toBe('Baja de la whitelist');
    for (const raw of ['TIPO_NUEVO', 'toString', '']) expect(operationTypeText(raw)).toBe(UNKNOWN_OPERATION_TEXT);
    expect(UNKNOWN_OPERATION_TEXT).toMatch(/abrí la app actualizada para ver el detalle/);
  });

  it('el motivo en texto, sin el detalle libre del backend', () => {
    expect(operationReasonText('NOT_SIGNED_IN_TIME')).toBe('pasaron 15 minutos sin tu firma');
    expect(operationReasonText('NONCE_CONSUMED: nonce on-chain 12')).toBe(
      'otra operación ya usó su número de orden en tu Safe',
    );
    expect(operationReasonText('REVERTED:GS013')).toBe('revirtió al ejecutarse en la red');
    expect(operationReasonText('POLICY_REJECTED: DESTINATION_NOT_WHITELISTED')).toBe(
      'no cumple las reglas de la plataforma: el destino no está activo en tu whitelist',
    );
    expect(operationReasonText('RETRIES_EXHAUSTED: SIGNER_UNAVAILABLE')).toBe(
      'no se pudo enviar después de varios intentos (el último problema: el servidor de firma de la plataforma no responde)',
    );
    // Un rechazo de la policy con un detalle libre: sólo el motivo general.
    expect(operationReasonText('POLICY_REJECTED: mandá los fondos a 0xabc')).toBe(
      'no cumple las reglas de la plataforma',
    );
  });

  it('un motivo desconocido: el código interno si tiene forma de código; si no, un texto genérico', () => {
    expect(operationReasonText('MOTIVO_NUEVO')).toBe('código interno MOTIVO_NUEVO');
    expect(operationReasonText('POLICY_REJECTED: REGLA_NUEVA')).toBe(
      'no cumple las reglas de la plataforma: código interno REGLA_NUEVA',
    );
    expect(operationReasonText('RETRIES_EXHAUSTED: PROBLEMA_NUEVO')).toMatch(/código interno PROBLEMA_NUEVO\)$/);
    for (const raw of ['Llamá al 0800 y dictá tu Password R', 'constructor', 'A'.repeat(40)]) {
      expect(operationReasonText(raw)).toBe('un motivo que esta versión de la app no reconoce');
    }
    expect(internalCode('  CODIGO_1 ')).toBe('CODIGO_1');
    expect(internalCode('codigo')).toBeNull();
  });
});
