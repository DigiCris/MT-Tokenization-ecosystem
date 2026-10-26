// [F-SES-04]: el aviso un minuto antes del bloqueo por inactividad dice qué se pierde (el cambio de Password U sin
// registrar) y qué no (el pedido de un reemplazo de R sigue al desbloquear en esa pantalla: N14 de la verificación de
// P17.MAN), sin prometer nada más.
import { describe, expect, it } from 'vitest';
import { INACTIVITY_WARNING_TEXT, KEEP_USING_LABEL } from './texts.ts';

describe('aviso de inactividad de la Wallet', () => {
  it('un minuto; el cambio de Password U sin registrar se pierde y el reemplazo de R sigue en esa pantalla', () => {
    expect(INACTIVITY_WARNING_TEXT).toBe(
      'La wallet se va a bloquear en menos de un minuto por inactividad. Si estás cambiando la Password U y todavía no la registraste, el cambio se pierde y vas a tener que hacerlo de nuevo, con backups nuevos. Si estás reemplazando tu clave de recuperación, el pedido a la app Recovery sigue: desbloqueá la wallet en esa misma pantalla para continuar.',
    );
    expect(KEEP_USING_LABEL).toBe('Seguir usando la Wallet');
  });
});
