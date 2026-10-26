// Textos de la sesión de la Wallet que también comprueban los tests (sin React): el aviso un minuto antes del bloqueo
// por inactividad ([F-SES-04]) y su botón.

/**
 * Un minuto antes del bloqueo por inactividad: lo que se pierde si llega, y lo que no (N14 de la verificación de
 * P17.MAN: el reemplazo de R sigue con el mismo pedido al desbloquear en esa pantalla).
 */
export const INACTIVITY_WARNING_TEXT =
  'La wallet se va a bloquear en menos de un minuto por inactividad. Si estás cambiando la Password U y todavía no la registraste, el cambio se pierde y vas a tener que hacerlo de nuevo, con backups nuevos. Si estás reemplazando tu clave de recuperación, el pedido a la app Recovery sigue: desbloqueá la wallet en esa misma pantalla para continuar.';

/** El botón del aviso: reinicia la cuenta de inactividad (como cualquier tecla, toque o scroll). */
export const KEEP_USING_LABEL = 'Seguir usando la Wallet';
