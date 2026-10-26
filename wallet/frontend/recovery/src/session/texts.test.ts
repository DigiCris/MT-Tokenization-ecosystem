// Textos de la sesión de Recovery (cuarta revisión de P17.MAN): el aviso antes del bloqueo por inactividad dice qué se
// pierde, y una R que no es firmante de la Safe se puede olvidar sólo si el dispositivo recuerda su sobre y no es R′ de
// un reemplazo en curso.
import { describe, expect, it } from 'vitest';
import {
  INACTIVITY_WARNING_TEXT,
  KEEP_USING_LABEL,
  notASignerText,
  pendingReplacementText,
  SEVERAL_ENVELOPES_TEXT,
} from './texts.ts';

describe('textos de la sesión', () => {
  it('el aviso de inactividad: un minuto, y qué pasa con una R sin enviar', () => {
    expect(INACTIVITY_WARNING_TEXT).toBe(
      'Recovery se va a bloquear en menos de un minuto por inactividad. Si estás creando tu clave R y todavía no enviaste su dirección, se va a descartar y lo que anotaste de ella no va a servir.',
    );
    expect(KEEP_USING_LABEL).toBe('Seguir usando Recovery');
  });

  it('varios sobres de la misma wallet: dónde ver la R vigente (con la wallet desbloqueada) y, si no se puede, probar (N8)', () => {
    expect(SEVERAL_ENVELOPES_TEXT).toContain(
      'la muestra la app Wallet en Seguridad → «Estado y reemplazo de tu clave de recuperación (R)», con la wallet desbloqueada.',
    );
    expect(SEVERAL_ENVELOPES_TEXT).toContain(
      'Si no podés verla, probá uno: al verificar tu Safe, Recovery te dice si no es y, si es de un pedido anterior, vas a poder olvidarlo.',
    );
  });

  it('una R que no es firmante: olvidar el sobre sólo si está recordado, y nunca el de R′ de un reemplazo', () => {
    expect(notASignerText(true)).toContain('olvidá su sobre en este dispositivo para no volver a elegirlo');
    expect(notASignerText(true)).toContain(
      'Si es la clave R nueva de un reemplazo que todavía no propusiste, no lo olvides.',
    );
    expect(notASignerText(false)).toBe(
      'Puede ser la de un pedido anterior que no se usó: desbloqueá el sobre de tu R vigente.',
    );
    expect(pendingReplacementText(new Date('2030-01-02T03:04:05Z'))).toMatch(
      /^Es la clave R nueva de un reemplazo en curso: va a ser tu clave de recuperación cuando se ejecute \(se puede desde el .+, hora de la red\)\. Para operar ahora, desbloqueá tu R vigente\.$/,
    );
  });
});
