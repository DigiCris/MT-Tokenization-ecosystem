// Textos de los backups de R que también comprueban los tests (sin React): lo que se dice de cada backup tiene que ser
// cierto sin la plataforma, coherente con el aviso de la Wallet y con el inicio de Recovery.

/**
 * El otro lado del riesgo (hallazgo 1 de la tercera revisión de P17.MAN): U y R juntas mueven los fondos sin la
 * plataforma (son 2 de las 3 firmas de la Safe), así que sus backups no se guardan juntos.
 */
export const R_APART_FROM_U_WARNING =
  'Guardá los backups de R lejos de los de tu clave U: quien tenga las dos puede mover tus fondos sin la plataforma.';

/**
 * Título de lo que se imprime o se anota de cada backup de R (hallazgo 7 de la tercera revisión): una hoja suelta tiene
 * que decir de qué app y de qué clave es, y con qué se abre.
 */
export const R_WORDS_TITLE = 'MT Recovery: 17 palabras de tu clave R';

export function rQrTitle(part: number, parts: number): string {
  return `MT Recovery: QR del sobre de tu clave R, parte ${String(part)} de ${String(parts)} (se abre con la Password R)`;
}

/** Al anotar las 17 palabras a mano, el mismo título que sale impreso. */
export const R_WORDS_HANDWRITTEN = `Si las anotás a mano, escribí arriba de qué clave son: «${R_WORDS_TITLE}».`;

/**
 * Qué permite cada backup de R sin la plataforma (hallazgo NB1 de la segunda revisión de P17.MAN): R sola no mueve
 * fondos (la Safe pide 2 de 3 firmas), así que hace falta además U. El U+2060 pega cada raya a la palabra de al lado,
 * para que no quede sola al final de un renglón.
 */
export const R_BACKUP_INTRO =
  'Hacé al menos un backup de R que no dependa de la plataforma (archivo, QR o 17 palabras). El archivo y el QR se abren con tu Password R; las 17 palabras no la necesitan. Sin la plataforma, para mover tus fondos hacen falta R y también tu clave U: si perdés las dos, nadie —\u2060tampoco MT Wallet\u2060— puede moverlos.';
