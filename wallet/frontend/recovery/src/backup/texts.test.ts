// Textos de los backups de R (segunda y tercera revisión de P17.MAN): qué permite cada backup sin la plataforma, que se
// guarden lejos de los de U (U y R juntas mueven los fondos) y el título de lo que se imprime o se anota a mano.
import { describe, expect, it } from 'vitest';
import { R_APART_FROM_U_WARNING, R_BACKUP_INTRO, R_WORDS_HANDWRITTEN, R_WORDS_TITLE, rQrTitle } from './texts.ts';

describe('textos de los backups de R', () => {
  it('sin la plataforma hacen falta R y U; y quien tenga las dos mueve los fondos', () => {
    expect(R_BACKUP_INTRO).toContain('hacen falta R y también tu clave U');
    expect(R_APART_FROM_U_WARNING).toBe(
      'Guardá los backups de R lejos de los de tu clave U: quien tenga las dos puede mover tus fondos sin la plataforma.',
    );
  });

  it('lo impreso (y lo anotado a mano) dice de qué app y de qué clave es, qué parte y con qué se abre', () => {
    expect(R_WORDS_TITLE).toBe('MT Recovery: 17 palabras de tu clave R');
    expect(rQrTitle(1, 1)).toBe('MT Recovery: QR del sobre de tu clave R, parte 1 de 1 (se abre con la Password R)');
    expect(rQrTitle(2, 3)).toBe('MT Recovery: QR del sobre de tu clave R, parte 2 de 3 (se abre con la Password R)');
    expect(R_WORDS_HANDWRITTEN).toBe(
      'Si las anotás a mano, escribí arriba de qué clave son: «MT Recovery: 17 palabras de tu clave R».',
    );
  });
});
