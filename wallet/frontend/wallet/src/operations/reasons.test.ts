// P18.MAN (M1, B1): los motivos que el backend informa con un código llegan a la pantalla en texto. El rechazo de la
// policy dice qué regla (el swap vencido: «venció el plazo del swap»), un reintento agotado dice el último problema, y
// un código que esta versión no conoce se muestra como código interno (para soporte), nunca solo; un texto libre, ni
// eso (revisión de seguridad de ADR-033).
import { describe, expect, it } from 'vitest';
import { destinationProblemText, operationReasonText, policyReasonText } from './reasons.ts';

describe('motivos de las operaciones', () => {
  it.each([
    ['POLICY_REJECTED: DEADLINE_INVALID', 'no cumple las reglas de la plataforma: venció el plazo del swap'],
    [
      'POLICY_REJECTED: LIMIT_DAILY',
      'no cumple las reglas de la plataforma: con este monto superarías el máximo que podés enviar en 24 h',
    ],
    [
      'POLICY_REJECTED: UNKNOWN_OPERATION',
      'no cumple las reglas de la plataforma: la plataforma no reconoce la operación',
    ],
    ['WHITELIST_INACTIVE: DESTINATION_NOT_WHITELISTED', 'el destino no está activo en tu whitelist'],
    ['INSUFFICIENT_BALANCE: INSUFFICIENT_BALANCE', 'no había saldo suficiente'],
    ['NONCE_CONSUMED: nonce on-chain 12', 'otra operación ya usó su número de orden en tu Safe'],
    [
      'SESSION_INVALID: PlatformSession inválida al momento del envío',
      'la sesión de la wallet se cerró o venció antes de que la plataforma la enviara',
    ],
    ['REVERTED:DeadlineExpired()', 'revirtió al ejecutarse en la red'],
    [
      'RETRIES_EXHAUSTED: SIGNER_UNAVAILABLE',
      'no se pudo enviar después de varios intentos (el último problema: el servidor de firma de la plataforma no responde)',
    ],
    ['SUPERSEDED_BY_NOOP', 'la reemplazó la operación vacía que firmaste para cancelarla'],
    ['PAIR_INCOMPLETE', 'faltó firmar la otra operación del swap'],
    ['COOPERATION_PAUSED', 'la plataforma pausó la co-firma por precaución'],
    ['RPC_TIMEOUT', 'la conexión con la red no respondió a tiempo'],
  ])('%s → %s', (raw, text) => {
    expect(operationReasonText(raw)).toBe(text);
  });

  it('un código desconocido se muestra como código interno; sin código, tampoco se inventa', () => {
    expect(operationReasonText('NEW_CODE_FROM_LATER: detalle')).toBe('código interno NEW_CODE_FROM_LATER');
    expect(operationReasonText('POLICY_REJECTED: NEW_RULE')).toBe(
      'no cumple las reglas de la plataforma: código interno NEW_RULE',
    );
    expect(operationReasonText('RETRIES_EXHAUSTED: NEW_RETRY')).toBe(
      'no se pudo enviar después de varios intentos (el último problema: código interno NEW_RETRY)',
    );
    // Un texto libre del backend nunca llega a la pantalla (revisión de ADR-033): ni frases ni direcciones.
    expect(operationReasonText('algo raro')).toBe('un motivo que esta versión de la app no reconoce');
    expect(operationReasonText('copiá 7184 D301 00a1 88c9 en Recovery')).toBe(
      'un motivo que esta versión de la app no reconoce',
    );
    expect(operationReasonText('X_7184D30100A188C9F869CCB6883392534ECD6C9D')).toBe(
      'un motivo que esta versión de la app no reconoce',
    );
    expect(policyReasonText('copiá esta dirección')).toBe('un motivo que esta versión de la app no reconoce');
  });

  it('rechazos de la policy y problemas del destino', () => {
    expect(policyReasonText('DEADLINE_INVALID')).toBe('venció el plazo del swap');
    expect(policyReasonText('SLIPPAGE_TOO_HIGH')).toMatch(/slippage de más de 0,5 %/);
    expect(destinationProblemText('SYSTEM_CONTRACT')).toBe('es un contrato del sistema de la plataforma');
    expect(destinationProblemText('OWN_SAFE')).toBe('es tu propia Safe');
    expect(destinationProblemText('OTHER')).toBe('código interno OTHER');
  });
});
