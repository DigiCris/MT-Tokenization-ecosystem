// Textos de la sesión de Recovery que también comprueban los tests (sin React): el aviso antes del bloqueo por
// inactividad y lo que dice RecoveryGate de una R que no es firmante de la Safe (cuarta revisión de P17.MAN).

/**
 * Aviso un minuto antes del bloqueo por inactividad (hallazgo 2): el bloqueo descarta una R creada acá que todavía no se
 * envió, y lo anotado de ella deja de servir. El aviso no pausa la cuenta.
 */
export const INACTIVITY_WARNING_TEXT =
  'Recovery se va a bloquear en menos de un minuto por inactividad. Si estás creando tu clave R y todavía no enviaste su dirección, se va a descartar y lo que anotaste de ella no va a servir.';

/** El botón del aviso: reinicia la cuenta de inactividad (como cualquier tecla o toque). */
export const KEEP_USING_LABEL = 'Seguir usando Recovery';

/**
 * La R desbloqueada no es firmante de la Safe (hallazgo 12): puede ser la de un sobre recordado de un pedido anterior.
 * Si el dispositivo recuerda su sobre, se puede olvidar; nunca el de R′ de un reemplazo que todavía no se propuso.
 */
export function notASignerText(remembered: boolean): string {
  return remembered
    ? 'Puede ser la de un pedido anterior que no se usó: si es así, olvidá su sobre en este dispositivo para no volver a elegirlo, y desbloqueá el de tu R vigente. Si es la clave R nueva de un reemplazo que todavía no propusiste, no lo olvides.'
    : 'Puede ser la de un pedido anterior que no se usó: desbloqueá el sobre de tu R vigente.';
}

/** Es R′ de un reemplazo en curso en Base: todavía no firma, y su sobre no se ofrece olvidar. */
export function pendingReplacementText(executableAt: Date): string {
  return `Es la clave R nueva de un reemplazo en curso: va a ser tu clave de recuperación cuando se ejecute (se puede desde el ${executableAt.toLocaleString('es-AR')}, hora de la red). Para operar ahora, desbloqueá tu R vigente.`;
}
