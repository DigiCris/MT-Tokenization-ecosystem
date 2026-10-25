// Textos del enrollment de R que también comprueban los tests (sin React). Bloqueante de la tercera revisión de P17.MAN:
// lo que se dice de dónde queda R tiene que ser cierto con el sobre recordado en este dispositivo y sin él (sin
// recordarlo, R sólo vive en la memoria de la pestaña hasta que se bloquea, y después hacen falta sus backups).

/** Casilla del paso de cifrado (marcada por defecto, como en la Wallet): sólo el sobre cifrado, [F-KEY-07]. */
export const REMEMBER_R_LABEL =
  'Recordar el sobre cifrado de R en este dispositivo (nunca la clave ni la Password R). Si el dispositivo es compartido, desmarcalo.';

/** Cada pedido de la Wallet pide una R nueva: la de un pedido anterior (y sus backups) ya no se usa. */
export const NEW_R_PER_REQUEST_TEXT =
  'Cada pedido crea una clave R nueva: si creaste otra para un pedido anterior, destruí sus backups.';

/** Pantalla final, R creada en este navegador con el sobre recordado. */
export const R_KEPT_TEXT =
  'Tu clave R no salió de esta app: a la plataforma sólo le llegó su dirección. Queda cifrada en este dispositivo (sólo se abre con tu Password R), pero igual necesitás sus backups fuera de él: si se borran los datos del navegador o perdés el dispositivo, son tu única copia.';

/** Pantalla final, R creada en este navegador sin recordar el sobre (o si no se pudo recordar). */
export const R_NOT_KEPT_TEXT =
  'Tu clave R no salió de esta app: a la plataforma sólo le llegó su dirección. Esta app no la guarda: se borra de este navegador al cerrar la pestaña, al tocar «Bloquear» o después de 5 minutos sin uso. Para usarla más adelante vas a necesitar uno de sus backups (el archivo o el QR con la Password R, o las 17 palabras).';

/** El dispositivo no dejó guardar el sobre (modo privado, datos del sitio bloqueados). */
export const R_KEEP_FAILED_TEXT =
  'No se pudo recordar el sobre cifrado de R en este dispositivo (el navegador no lo permitió): vas a necesitar sus backups.';

/** Pantalla final con una wallet externa como R. */
export const R_EXTERNAL_TEXT =
  'Tu clave R es la de tu wallet externa y queda en ella: a la plataforma sólo le llegó su dirección.';

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
