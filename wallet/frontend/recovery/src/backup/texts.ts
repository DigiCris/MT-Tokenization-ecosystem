// Textos de los backups de R que también comprueban los tests (sin React): lo que se dice de cada backup tiene que ser
// cierto sin la plataforma, coherente con el aviso de la Wallet y con el inicio de Recovery. Cuarta revisión de
// P17.MAN (hallazgo 1): lo impreso y lo anotado lleva la dirección abreviada de esa R, así los backups de una R se
// distinguen de los de otra (la de un pedido anterior o R′ en un reemplazo).
import type { Address } from 'viem';
import { shortAddress } from '../chain/address.ts';

/**
 * El otro lado del riesgo (hallazgo 1 de la tercera revisión de P17.MAN): U y R juntas mueven los fondos sin la
 * plataforma (son 2 de las 3 firmas de la Safe), así que sus backups no se guardan juntos. Tampoco las dos Password:
 * los dos sobres pueden quedar recordados en el mismo dispositivo (hallazgo 8 de la cuarta revisión).
 */
export const R_APART_FROM_U_WARNING =
  'Guardá los backups y la Password R lejos de los de tu clave U (y de tu Password U): quien tenga las dos puede mover tus fondos sin la plataforma.';

/**
 * Título de lo que se imprime o se anota de cada backup de R (hallazgo 7 de la tercera revisión): una hoja suelta tiene
 * que decir de qué app y de qué clave es, con qué se abre y, con la dirección abreviada, de qué R.
 */
export function rWordsTitle(address: Address): string {
  return `MT Recovery: 17 palabras de tu clave R ${shortAddress(address)}`;
}

export function rQrTitle(address: Address, part: number, parts: number): string {
  return `MT Recovery: QR del sobre de tu clave R ${shortAddress(address)}, parte ${String(part)} de ${String(parts)} (se abre con la Password R)`;
}

/** Al anotar las 17 palabras a mano, el mismo título que sale impreso, con la dirección. */
export function rWordsHandwritten(address: Address): string {
  return `Si las anotás a mano, escribí arriba de qué clave son, con su dirección: «${rWordsTitle(address)}».`;
}

/**
 * El rótulo del papel de la Password R: con la dirección de R si ya se conoce en ese paso (al restaurar desde las 17
 * palabras); al crear R todavía no existe, y la pantalla final pide anotarla después.
 */
export function passwordRPaperText(address: Address | null): string {
  const label = address === null ? 'MT Recovery: Password R' : `MT Recovery: Password R de ${shortAddress(address)}`;
  return `Arriba del papel escribí «${label}».`;
}

/**
 * Qué permite cada backup de R sin la plataforma (hallazgo NB1 de la segunda revisión de P17.MAN): R sola no mueve
 * fondos (la Safe pide 2 de 3 firmas), así que hace falta además U. El U+2060 pega cada raya a la palabra de al lado,
 * para que no quede sola al final de un renglón.
 */
export const R_BACKUP_INTRO =
  'Hacé al menos un backup de R que no dependa de la plataforma (archivo, QR o 17 palabras). El archivo y el QR se abren con tu Password R; las 17 palabras no la necesitan. Sin la plataforma, para mover tus fondos hacen falta R y también tu clave U: si perdés las dos, nadie —\u2060tampoco MT Wallet\u2060— puede moverlos.';
