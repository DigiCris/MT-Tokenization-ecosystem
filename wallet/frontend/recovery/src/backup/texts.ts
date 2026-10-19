// Textos de los backups de R que también comprueban los tests (sin React): lo que se dice de cada backup tiene que ser
// cierto sin la plataforma, coherente con el aviso de la Wallet y con el inicio de Recovery.

/**
 * Qué permite cada backup de R sin la plataforma (hallazgo NB1 de la segunda revisión de P17.MAN): R sola no mueve
 * fondos (la Safe pide 2 de 3 firmas), así que hace falta además U. El U+2060 pega cada raya a la palabra de al lado,
 * para que no quede sola al final de un renglón.
 */
export const R_BACKUP_INTRO =
  'Hacé al menos un backup de R que no dependa de la plataforma (archivo, QR o 17 palabras). El archivo y el QR se abren con tu Password R; las 17 palabras no la necesitan. Sin la plataforma, para mover tus fondos hacen falta R y también tu clave U: si perdés las dos, nadie —\u2060tampoco MT Wallet\u2060— puede moverlos.';
