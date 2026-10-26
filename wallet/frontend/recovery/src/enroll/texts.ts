// Textos del enrollment de R que también comprueban los tests (sin React). Bloqueante de la tercera revisión de P17.MAN:
// lo que se dice de dónde queda R tiene que ser cierto con el sobre recordado en este dispositivo y sin él (sin
// recordarlo, R sólo vive en la memoria de la pestaña hasta que se bloquea, y después hacen falta sus backups).
//
// Cuarta revisión de P17.MAN: los avisos de «otra R» dicen qué destruir (lo que no tiene la dirección de la R nueva,
// también su Password R) y la pantalla final pide anotar la dirección de esta R en sus backups (hallazgo 1); si Recovery
// se bloquea con una R sin enviar, se dice que se descartó y qué hacer con lo anotado (2); un envío a un pedido que ya
// no la espera dice qué pasó, nunca «recargá la pantalla» (4); el pedido de reemplazo cancelado tiene su texto (5); los
// textos nombran la copia de Drive y la wallet externa (7 y 9). Con una wallet externa nada pide destruir backups: su
// frase de recuperación es el backup de R. Verificación de P17.MAN: en un reemplazo, lo que se destruye no tiene ni la
// dirección de la R nueva ni la de la actual (N5), y una R descartada se nombra por su dirección, con su Password R y,
// en un reemplazo, sin tocar los backups de la R actual (N6).
import type { Address } from 'viem';
import type { EnrollmentStatus } from '../api/recovery-api.ts';
import { shortAddress } from '../chain/address.ts';
import type { LockReason } from '../session/store.ts';

/** Casilla del paso de cifrado (marcada por defecto, como en la Wallet): sólo el sobre cifrado, [F-KEY-07]. */
export const REMEMBER_R_LABEL =
  'Recordar el sobre cifrado de R en este dispositivo (nunca la clave ni la Password R). Si el dispositivo es compartido, desmarcalo.';

/**
 * Cada pedido de la Wallet pide una R nueva: la de un pedido anterior (o una de este mismo pedido que se descartó) ya
 * no se usa, y sus backups son los que no llevan la dirección de la R nueva.
 */
export const NEW_R_PER_REQUEST_TEXT =
  'Cada pedido crea una clave R nueva. Si ya creaste otra (para este pedido o para uno anterior), destruí sus backups (archivo, QR y 17 palabras) y su Password R: son los que no tienen la dirección de la R nueva.';

/**
 * Lo mismo en un reemplazo de R: la R actual no es «la de un pedido anterior» que se descarta. Sigue siendo la de
 * recuperación (y puede cancelar el reemplazo) hasta que se ejecute: sus backups no se destruyen. Y tampoco tienen la
 * dirección de la R nueva, así que lo que se destruye es lo que no tiene ninguna de las dos (N5 de la verificación).
 */
export const REPLACEMENT_NEW_R_PER_REQUEST_TEXT =
  'Cada pedido crea una clave R nueva. Si ya creaste otra para este reemplazo o para uno anterior, destruí sus backups (archivo, QR y 17 palabras) y su Password R: son los que no tienen ni la dirección de la R nueva ni la de tu R actual. Los de tu R actual, no: sigue siendo tu clave de recuperación (y puede cancelar el reemplazo) hasta que se ejecute.';

/**
 * Pantalla final, R creada en este navegador con el sobre recordado. `drive`: también quedó una copia en la carpeta de
 * Recovery en Drive (es uno de sus backups, hallazgo 7 de la cuarta revisión).
 */
export function rKeptText(drive: boolean): string {
  const backups = drive
    ? 'el archivo, el QR, las 17 palabras o la copia de Drive'
    : 'el archivo, el QR o las 17 palabras';
  return `Tu clave R no salió de esta app: a la plataforma sólo le llegó su dirección. Queda cifrada en este dispositivo (sólo se abre con tu Password R), pero igual necesitás sus backups fuera de él (${backups}): si se borran los datos del navegador o perdés el dispositivo, son tu única copia.`;
}

/** Pantalla final, R creada en este navegador sin recordar el sobre (o si no se pudo recordar). */
export function rNotKeptText(drive: boolean): string {
  const backups = drive
    ? 'el archivo, el QR o la copia de Drive con la Password R, o las 17 palabras'
    : 'el archivo o el QR con la Password R, o las 17 palabras';
  return `Tu clave R no salió de esta app: a la plataforma sólo le llegó su dirección. Esta app no la guarda: se borra de este navegador al cerrar la pestaña, al tocar «Bloquear» o después de 5 minutos sin uso. Para usarla más adelante vas a necesitar uno de sus backups (${backups}).`;
}

/** El dispositivo no dejó guardar el sobre (modo privado, datos del sitio bloqueados). */
export const R_KEEP_FAILED_TEXT =
  'No se pudo recordar el sobre cifrado de R en este dispositivo (el navegador no lo permitió): vas a necesitar sus backups.';

/**
 * Pantalla final con una wallet externa como R: su frase de recuperación es el backup de R, y junto con U mueve los
 * fondos sin la plataforma (hallazgo 9 de la cuarta revisión).
 */
export const R_EXTERNAL_TEXT =
  'Tu clave R es la de tu wallet externa y queda en ella: a la plataforma sólo le llegó su dirección. Su frase de recuperación es el backup de R: guardala lejos de los backups de tu clave U; quien tenga las dos puede mover tus fondos sin la plataforma.';

/** Antes de conectar una wallet externa como R (el mismo aviso, dicho como consejo). */
export const EXTERNAL_R_ADVICE =
  'Usá una wallet que no uses a diario: su frase de recuperación es el backup de R. Guardala lejos de los backups de tu clave U: quien tenga las dos puede mover tus fondos sin la plataforma.';

/**
 * Pantalla final de una R creada acá: su dirección, para anotarla en sus backups y en el papel de su Password R (que se
 * anotó antes de que R existiera). Así se distinguen de los de otra R (hallazgo 1 de la cuarta revisión).
 */
export function rAddressOnBackupsText(address: Address): string {
  return `Anotá en los backups de esta R y en el papel de su Password R su dirección (${shortAddress(address)}): así los distinguís de los de una R anterior.`;
}

/** Con el `k` del pedido: el enlace de regreso o, desde otro dispositivo, los 10 grupos a mano. */
export const RETURN_WITH_SECRET_TEXT =
  'Si la Wallet está en este dispositivo, abrí «Volver a la Wallet»: la dirección se confirma sola en la pestaña donde generaste el pedido. Si está en otro dispositivo, copiá ahí los 10 grupos que siguen al «0x», uno por uno (da igual mayúsculas o minúsculas):';

/** Para qué sirve el QR de regreso. */
export const RETURN_QR_TEXT =
  'Si la Wallet está en tu celular, escaneá este QR con él: se abre la Wallet con esta dirección para la pestaña donde generaste el pedido.';

/**
 * El enlace de ida no traía `k` (la Wallet actual siempre lo pone): un enlace de regreso sin `k` la Wallet lo toma como
 * falsificado y cancela el pedido, así que no se ofrece y la dirección se copia a mano (ADR-033).
 */
export const RETURN_WITHOUT_SECRET_TEXT =
  'El enlace con el que abriste este pedido no traía el código secreto que le agrega la app Wallet, así que acá no hay enlace de regreso: la Wallet lo rechazaría y cancelaría el pedido. Volvé a la pestaña de la Wallet donde generaste el pedido y copiá ahí los 10 grupos que siguen al «0x», uno por uno (da igual mayúsculas o minúsculas):';

/** El estado del pedido al abrir el enlace (antes de crear R en esta pantalla). */
export const STATUS_TEXT: Record<EnrollmentStatus['status'], string> = {
  REQUESTED: 'Pendiente',
  SUBMITTED: 'Ya se envió la dirección de una clave R para este pedido.',
  CONFIRMED: 'Este pedido ya terminó: la Wallet confirmó la dirección de tu clave R.',
  EXPIRED: 'El pedido venció (dura 15 minutos): generá uno nuevo desde la app Wallet.',
  REJECTED: 'El pedido fue rechazado: generá uno nuevo desde la app Wallet.',
  RETIRED: 'El pedido fue reemplazado por otro: usá el enlace más reciente de la app Wallet.',
};

/**
 * Un pedido rechazado: reemplazado por uno más nuevo o cancelado por la Wallet porque no pudo confirmar R. En un
 * reemplazo, «la anterior» no es la R actual: ésa sigue vigente (hallazgo 5 de la cuarta revisión). `purpose` es el
 * propósito efectivo (enrollment.ts, effectivePurpose).
 */
export function rejectedText(
  reason: EnrollmentStatus['rejectionReason'],
  purpose: EnrollmentStatus['purpose'],
): string {
  if (reason === 'SUPERSEDED') {
    return 'La app Wallet generó un pedido más nuevo: usá el enlace o el QR más reciente de la app Wallet.';
  }
  if (reason === null || reason === undefined) return STATUS_TEXT.REJECTED;
  if (purpose === 'REPLACEMENT') {
    return 'La app Wallet canceló este pedido de reemplazo porque no pudo confirmar la dirección de la clave R nueva. Si generás otro, Recovery va a crear otra R nueva: los backups de la que creaste para este pedido ya no sirven. Los de tu R actual, sí: sigue siendo tu clave de recuperación hasta que el reemplazo se ejecute.';
  }
  return 'La app Wallet canceló este pedido porque no pudo confirmar la dirección de tu clave R. Generá uno nuevo desde la app Wallet: Recovery va a crear otra clave R, y los backups de la anterior ya no sirven. Destruilos, también su Password R: son los que no tienen la dirección de la R nueva.';
}

/** En un reemplazo de R, lo de la R actual no se destruye: sigue vigente hasta que el reemplazo se ejecute. */
const KEEP_CURRENT_R = 'Los de tu R actual, no.';

/**
 * Recovery se bloqueó (botón «Bloquear», inactividad, verificación vencida o salida) con una R creada acá que todavía
 * no se envió: se descartó, y lo anotado o guardado de ella no sirve (hallazgo 2 de la cuarta revisión). Con R ya
 * cifrada, su dirección dice qué backups son (N6 de la verificación); antes, sólo existía su Password R. En un
 * reemplazo, los de la R actual no se destruyen. `purpose` es el propósito efectivo (enrollment.ts, effectivePurpose).
 */
export function interruptedInternalText(address: Address | null, purpose: EnrollmentStatus['purpose']): string {
  const what =
    address === null
      ? 'Recovery se bloqueó y la clave R que estabas creando se descartó sin enviarse. Destruí lo que anotaste de ella (su Password R) y creá otra.'
      : `Recovery se bloqueó y la clave R que estabas creando (${shortAddress(address)}) se descartó sin enviarse. Destruí lo que anotaste o guardaste de ella (su Password R y sus backups: archivo, QR y 17 palabras, con esa dirección) y creá otra.`;
  return purpose === 'REPLACEMENT' ? `${what} ${KEEP_CURRENT_R}` : what;
}

/** Lo mismo con una wallet externa: se desconectó sin enviar nada (y no hay nada que destruir). */
export const INTERRUPTED_EXTERNAL_TEXT =
  'Recovery se bloqueó antes de enviar la dirección de tu wallet externa: no se envió nada. Verificá tu identidad de nuevo y volvé a conectarla.';

/** Por qué se bloqueó, mientras se sabe (hasta que se vuelve a verificar la identidad). */
export function lockReasonText(reason: LockReason): string {
  switch (reason) {
    case 'MANUAL':
      return 'Se bloqueó porque tocaste «Bloquear».';
    case 'INACTIVITY':
      return 'Se bloqueó por inactividad: pasaron 5 minutos sin usar Recovery.';
    case 'EXPIRED':
      return 'Se bloqueó porque venció la verificación de tu identidad (dura 15 minutos).';
    case 'LOGOUT':
      return 'Se bloqueó porque cerraste sesión.';
  }
}

/**
 * Por qué una R ya creada no se va a usar, después de un envío que no llegó a este pedido (hallazgo 4 de la cuarta
 * revisión): reemplazado por uno más nuevo, cancelado por la Wallet, vencido, retirado, con otra R ya enviada (desde
 * otra pestaña o dispositivo) o que la plataforma ya no encuentra.
 */
export type UnusedCause = 'SUPERSEDED' | 'CANCELLED' | 'EXPIRED' | 'RETIRED' | 'OTHER_KEY' | 'NOT_FOUND';

/** Por qué no se va a usar una R creada acá y, si hace falta, qué hacer después. */
const UNUSED_INTERNAL: Record<UnusedCause, { why: string; next: string | null }> = {
  SUPERSEDED: {
    why: 'La app Wallet generó un pedido más nuevo',
    next: 'Abrí el enlace o el QR más reciente de la app Wallet.',
  },
  CANCELLED: { why: 'La app Wallet canceló este pedido', next: 'Generá un pedido nuevo desde la app Wallet.' },
  EXPIRED: {
    why: 'El pedido venció antes de enviar la dirección',
    next: 'Generá un pedido nuevo desde la app Wallet.',
  },
  RETIRED: { why: 'El pedido fue reemplazado por otro', next: 'Abrí el enlace o el QR más reciente de la app Wallet.' },
  OTHER_KEY: {
    why: 'Para este pedido ya se envió la dirección de otra clave R (desde otra pestaña u otro dispositivo)',
    next: null,
  },
  NOT_FOUND: { why: 'La plataforma ya no encuentra este pedido', next: 'Generá un pedido nuevo desde la app Wallet.' },
};

const UNUSED_EXTERNAL: Record<UnusedCause, string> = {
  SUPERSEDED:
    'La app Wallet generó un pedido más nuevo: abrí el enlace o el QR más reciente de la app Wallet y volvé a conectar tu wallet externa.',
  CANCELLED:
    'La app Wallet canceló este pedido: generá un pedido nuevo desde la app Wallet y volvé a conectar tu wallet externa.',
  EXPIRED:
    'El pedido venció antes de enviar la dirección: generá un pedido nuevo desde la app Wallet y volvé a conectar tu wallet externa.',
  RETIRED:
    'El pedido fue reemplazado por otro: abrí el enlace o el QR más reciente de la app Wallet y volvé a conectar tu wallet externa.',
  OTHER_KEY:
    'Para este pedido ya se envió la dirección de otra clave R (desde otra pestaña u otro dispositivo): la de tu wallet externa no se va a usar.',
  NOT_FOUND:
    'La plataforma ya no encuentra este pedido: generá un pedido nuevo desde la app Wallet y volvé a conectar tu wallet externa.',
};

/**
 * Una R que no se va a usar. Si se creó acá, cuál es (su dirección, también la de sus backups) y qué destruir, también
 * su Password R; en un reemplazo, los backups de la R actual no (N6 de la verificación de P17.MAN). Con una wallet
 * externa no hay nada que destruir. `purpose` es el propósito efectivo (enrollment.ts, effectivePurpose).
 */
export function unusedText(
  cause: UnusedCause,
  key: { kind: 'internal' | 'external'; address: Address },
  purpose: EnrollmentStatus['purpose'],
): string {
  if (key.kind === 'external') return UNUSED_EXTERNAL[cause];
  const { why, next } = UNUSED_INTERNAL[cause];
  const destroy = `esta clave R (${shortAddress(key.address)}) no se va a usar; destruí sus backups (archivo, QR y 17 palabras, con esa dirección) y su Password R.`;
  return [`${why}: ${destroy}`, purpose === 'REPLACEMENT' ? KEEP_CURRENT_R : null, next]
    .filter((part) => part !== null)
    .join(' ');
}

/** El backend no aceptó el envío pero el pedido sigue abierto (p. ej. el reloj del dispositivo corrido). */
export const SUBMIT_STILL_OPEN_TEXT =
  'La plataforma no aceptó el envío, aunque el pedido sigue abierto: revisá la fecha y hora de este dispositivo y volvé a intentar.';

/** Ni el envío ni la relectura del pedido funcionaron (sin red): se puede reintentar. */
export const SUBMIT_REREAD_FAILED_TEXT =
  'No se pudo enviar la dirección ni volver a leer el pedido: revisá tu conexión y volvé a intentar.';

/**
 * La plataforma no aceptó registrar este dispositivo para el pedido y no se lo pudo volver a leer (sin red). Todavía no
 * hay ninguna R creada acá, así que volver a abrir el enlace no pierde nada.
 */
export const REGISTER_REREAD_FAILED_TEXT =
  'No se pudo preparar este dispositivo para el pedido ni volver a leerlo: revisá tu conexión y abrí de nuevo el enlace o el QR de la app Wallet.';

/** La Enrollment Key de otra pestaña o dispositivo ya está registrada para este pedido (antes de crear R acá). */
export const ENROLLMENT_IN_USE_TEXT =
  'Este pedido ya se abrió en otra pestaña o en otro dispositivo: seguí ahí, o generá un pedido nuevo desde la app Wallet.';
