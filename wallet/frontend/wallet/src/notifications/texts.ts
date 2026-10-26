// Textos de los avisos del reemplazo de U que también comprueban los tests (sin React). Mientras el reemplazo está en
// borrador o rechazado, ningún aviso muestra la U′ que informa la plataforma (ESC-41, B1 de la verificación de P17.MAN).

/**
 * El reemplazo de U quedó en borrador para que R lo proponga desde la app Recovery: todavía no hay propuesta que
 * cancelar, y la dirección de la clave U nueva se copia sólo de la pantalla final de «Perdí mi Password U».
 */
export const RECOVERY_STARTED_TEXT =
  'Se inició el reemplazo de tu clave de usuario (U) con tu clave de recuperación (R). En la app Recovery copiá la dirección de la clave U nueva sólo de la pantalla final de «Perdí mi Password U», nunca de un aviso, un email o un chat. Si no fuiste vos, avisá a soporte.';

/** La app Recovery canceló el borrador porque la U′ no coincidió: puede ser un error al copiar o una U′ cambiada. */
export const U_REPLACEMENT_REJECTED_TEXT =
  'La app Recovery canceló el reemplazo de tu clave U porque la dirección no coincidió: alguien pudo haberla cambiado. Si la habías copiado bien, avisá a soporte. Podés empezar de nuevo desde «Perdí mi Password U».';
