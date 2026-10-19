// Motivos que el backend informa con un código (rechazos de la policy, fallas y reintentos del pipeline de operaciones,
// validación del destino) en texto para el usuario (P18.MAN): qué pasó, sin códigos crudos. Un código que esta versión
// de la app no conoce se muestra como "código interno", para poder consultarlo con soporte.

/** Rechazos de la policy de la plataforma ([B-POL]): el `detail` de POLICY_REJECTED o el motivo de una operación. */
const POLICY_REASON_TEXT: Readonly<Record<string, string>> = {
  UNKNOWN_OPERATION: 'la plataforma no reconoce la operación',
  OPERATION_TYPE_MISMATCH: 'la operación no es del tipo con el que se preparó',
  OPERATION_NOT_ALLOWED: 'esa operación no está habilitada para tu wallet',
  DESTINATION_FORBIDDEN: 'el destino no está permitido (tu propia Safe, un token o un contrato del sistema)',
  DESTINATION_NOT_WHITELISTED: 'el destino no está activo en tu whitelist',
  BELOW_MINIMUM: 'el monto es menor que el mínimo por operación',
  LIMIT_PER_OPERATION: 'el monto supera el máximo por operación',
  LIMIT_DAILY: 'con este monto superarías el máximo que podés enviar en 24 h',
  SWAP_LIMIT: 'el monto supera el máximo por swap',
  TWO_FACTOR_REQUIRED: 'falta confirmar el segundo factor',
  CHALLENGE_REQUIRED: 'falta confirmar el código del email',
  INSUFFICIENT_BALANCE: 'no hay saldo suficiente',
  SLIPPAGE_TOO_HIGH: 'el mínimo a recibir queda por debajo de lo que acepta la plataforma (slippage de más de 0,5 %)',
  DEADLINE_INVALID: 'venció el plazo del swap',
  SWAP_PAIRING_INVALID: 'el permiso y el swap no corresponden entre sí',
  ROTATION_INVALID: 'la rotación no es válida',
  ROTATION_NOT_EXECUTABLE: 'la rotación todavía no se puede ejecutar (falta que se cumpla el plazo de 48 h)',
  KEY_ACCEPTANCE_REQUIRED: 'falta la aceptación firmada de la clave nueva',
  ROTATION_TARGET_NOT_SIGNER_KEY: 'la clave nueva de la plataforma no es una de las que crea su servidor de firma',
  MIGRATION_PARTIAL: 'la migración tiene que transferir todo el saldo',
  GUARD_UPGRADE_INVALID: 'el cambio del Guard no es válido',
};

/** Motivos de las operaciones (`failureReason` / `lastErrorCode`): fallas definitivas, cancelaciones y reintentos. */
const OPERATION_REASON_TEXT: Readonly<Record<string, string>> = {
  POLICY_REJECTED: 'no cumple las reglas de la plataforma',
  WHITELIST_INACTIVE: 'el destino no está activo en tu whitelist',
  INSUFFICIENT_BALANCE: 'no había saldo suficiente',
  NONCE_CONSUMED: 'otra operación ya usó su número de orden en tu Safe',
  SESSION_INVALID: 'la sesión de la wallet se cerró o venció antes de que la plataforma la enviara',
  SIGNATURE_STALE: 'tu firma tiene más de 24 h',
  INTEGRITY_MISMATCH: 'lo firmado no coincide con lo que se preparó',
  OWNER_SIGNATURE_INVALID: 'la firma no es válida',
  OWNER_NOT_ROLE: 'la firma no es de tu clave vigente',
  SAFE_CONFIG_MODIFIED: 'la configuración de tu Safe cambió fuera de la plataforma',
  GUARD_WOULD_REVERT: 'el Guard de seguridad de tu Safe la rechazaría en la red',
  KEY_NOT_FOUND: 'la clave de la plataforma (S) no coincide con la registrada',
  RETRIES_EXHAUSTED: 'no se pudo enviar después de varios intentos',
  CANCEL_TOO_LATE: 'la operación original se ejecutó antes que su cancelación',
  SUPERSEDED_BY_NOOP: 'la reemplazó la operación vacía que firmaste para cancelarla',
  NOT_SIGNED_IN_TIME: 'pasaron 15 minutos sin tu firma',
  USER_CANCELLED: 'la cancelaste antes de que se enviara a la red',
  PAIR_INCOMPLETE: 'faltó firmar la otra operación del swap',
  SWAP_NOT_EXECUTED: 'el swap no se ejecutó',
  POLICY_VERSION_MISMATCH: 'cambiaron las reglas de la plataforma mientras se procesaba',
  STATIC_RULE_VIOLATION: 'el servidor de firma de la plataforma la rechazó por sus reglas fijas',
  SAFE_NOT_REGISTERED: 'el servidor de firma de la plataforma no tiene registrada tu Safe',
  SAFE_NONCE_CONFLICT: 'otra operación ocupa su número de orden en tu Safe',
  SIMULATION_REVERTED: 'la simulación en la red falló',
  REVERTED: 'revirtió al ejecutarse en la red',
  // Reintentos: la plataforma vuelve a intentar sola.
  NONCE_NOT_REACHED: 'espera que se ejecute una operación anterior de tu Safe',
  FEE_CAP_EXCEEDED: 'el costo de la red está por encima del máximo que paga la plataforma',
  SIGNER_UNAVAILABLE: 'el servidor de firma de la plataforma no responde',
  SIGNER_BAD_RESPONSE: 'el servidor de firma de la plataforma respondió con un error',
  SIGNER_RESPONSE_MISMATCH: 'la respuesta del servidor de firma no coincidió con lo pedido',
  COOPERATION_PAUSED: 'la plataforma pausó la co-firma por precaución',
  INTEGRITY_UNREACHABLE: 'la plataforma no pudo comprobar la integridad de las apps',
  ACCOUNT_NONCE_MISMATCH: 'la cuenta que paga el gas de la plataforma está ocupada',
  INSUFFICIENT_GAS_FUNDS: 'la plataforma no tiene fondos para el gas en este momento',
  GAS_TANK_CAP_EXCEEDED: 'se alcanzó el gasto de gas máximo de la plataforma',
  PLATFORM_TX_REJECTED: 'la red rechazó la transacción de la plataforma',
  TX_MISSING: 'la red todavía no muestra la transacción',
  TX_DROPPED: 'la red descartó la transacción',
  REVERTED_TRANSIENT: 'revirtió en la red por un problema transitorio',
  RPC_TIMEOUT: 'la conexión con la red no respondió a tiempo',
  RPC_UNAVAILABLE: 'la conexión con la red no está disponible',
  RPC_DISAGREEMENT: 'las conexiones con la red no coinciden',
  RPC_CHAIN_MISMATCH: 'la conexión con la red apunta a otra red',
};

/** Problemas del destino de la whitelist (`detail` de DESTINATION_INVALID). */
const DESTINATION_PROBLEM_TEXT: Readonly<Record<string, string>> = {
  INVALID_FORMAT: 'no es una dirección de Base (0x y 40 caracteres)',
  BAD_CHECKSUM: 'tiene un error de tipeo (el checksum EIP-55 no coincide)',
  ZERO_ADDRESS: 'es la dirección cero',
  OWN_SAFE: 'es tu propia Safe',
  SYSTEM_CONTRACT: 'es un contrato del sistema de la plataforma',
  TOKEN_CONTRACT: 'es el contrato de un token',
};

const unknownCode = (code: string) => `código interno ${code}`;

/** Un rechazo de la policy en texto (sin mayúscula inicial ni punto final). */
export function policyReasonText(code: string): string {
  return POLICY_REASON_TEXT[code] ?? unknownCode(code);
}

/** Un problema del destino en texto (sin mayúscula inicial ni punto final). */
export function destinationProblemText(code: string): string {
  return DESTINATION_PROBLEM_TEXT[code] ?? unknownCode(code);
}

/**
 * El motivo de una operación (`failureReason` como lo guarda el backend: `CÓDIGO`, `CÓDIGO: detalle` o
 * `REVERTED:motivo`) en texto. Los rechazos de la policy dicen además qué regla, y un reintento agotado, el último
 * problema.
 */
export function operationReasonText(raw: string): string {
  const match = /^([A-Z][A-Z0-9_]*)(?::\s*([\s\S]*))?$/.exec(raw.trim());
  if (!match?.[1]) return unknownCode(raw.trim());
  const [, code, detail = ''] = match;
  const policyCode = /^[A-Z][A-Z0-9_]*$/.test(detail) ? detail : null;
  if (code === 'POLICY_REJECTED' && policyCode !== null) {
    return `${OPERATION_REASON_TEXT.POLICY_REJECTED ?? ''}: ${policyReasonText(policyCode)}`;
  }
  if (code === 'RETRIES_EXHAUSTED' && policyCode !== null) {
    const last = OPERATION_REASON_TEXT[policyCode] ?? unknownCode(policyCode);
    return `${OPERATION_REASON_TEXT.RETRIES_EXHAUSTED ?? ''} (el último problema: ${last})`;
  }
  return OPERATION_REASON_TEXT[code] ?? unknownCode(code);
}
