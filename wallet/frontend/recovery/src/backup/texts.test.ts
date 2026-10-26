// Textos de los backups de R (segunda, tercera y cuarta revisión de P17.MAN): qué permite cada backup sin la plataforma,
// que se guarden lejos de los de U (U y R juntas mueven los fondos), con la Password R también lejos de la Password U, y
// el título de lo que se imprime o se anota a mano, con la dirección abreviada de esa R para distinguir sus backups.
import { describe, expect, it } from 'vitest';
import {
  passwordRPaperText,
  R_APART_FROM_U_WARNING,
  R_BACKUP_INTRO,
  rQrTitle,
  rWordsHandwritten,
  rWordsTitle,
} from './texts.ts';

const R = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** La dirección abreviada, con espacios que no cortan (U+00A0, N9). */
const SHORT = '0x\u00a08335\u00a0…\u00a02913';

describe('textos de los backups de R', () => {
  it('sin la plataforma hacen falta R y U; y quien tenga las dos mueve los fondos', () => {
    expect(R_BACKUP_INTRO).toContain('hacen falta R y también tu clave U');
    expect(R_APART_FROM_U_WARNING).toBe(
      'Guardá los backups y la Password R lejos de los de tu clave U (y de tu Password U): quien tenga las dos puede mover tus fondos sin la plataforma.',
    );
  });

  it('lo impreso (y lo anotado a mano) dice de qué app, de qué R (su dirección), qué parte y con qué se abre', () => {
    expect(rWordsTitle(R)).toBe(`MT Recovery: 17 palabras de tu clave R ${SHORT}`);
    expect(rQrTitle(R, 1, 1)).toBe(
      `MT Recovery: QR del sobre de tu clave R ${SHORT}, parte 1 de 1 (se abre con la Password R)`,
    );
    expect(rQrTitle(R.toLowerCase() as `0x${string}`, 2, 3)).toBe(
      `MT Recovery: QR del sobre de tu clave R ${SHORT}, parte 2 de 3 (se abre con la Password R)`,
    );
    expect(rWordsHandwritten(R)).toBe(
      `Si las anotás a mano, escribí arriba de qué clave son, con su dirección: «MT Recovery: 17 palabras de tu clave R ${SHORT}».`,
    );
  });

  it('el papel de la Password R lleva la dirección sólo si ya se conoce en ese paso', () => {
    expect(passwordRPaperText(null)).toBe('Arriba del papel escribí «MT Recovery: Password R».');
    expect(passwordRPaperText(R)).toBe(`Arriba del papel escribí «MT Recovery: Password R de ${SHORT}».`);
  });
});
