// Avisos in-app que crea el backend ([B-MAIL-03], P15.T07: los mismos eventos que van por email) en texto para la app:
// qué pasó, con las direcciones completas, y a qué pantalla ir. Son la "alerta in-app" de ADR-006 y del threat model
// (ESC-02, ESC-16, ESC-20, ESC-23, ESC-33, ESC-34). El payload viene del backend: sólo se muestra como texto, una
// dirección inválida no se renderiza como dirección y un tipo desconocido queda como aviso genérico.
import { getAddress, isAddress, type Address } from 'viem';
import type { AppNotification } from '../api/wallet-api.ts';
import { formatAmount, parseDecimalAmount } from '../assets/amount.ts';
import { ROLE_TEXT, type DescriptionPart } from '../operations/describe.ts';
import type { NameOf } from '../operations/names.ts';

export interface NotificationView {
  tone: 'info' | 'warning' | 'error';
  parts: DescriptionPart[];
  link: { to: string; label: string } | null;
}

const ROTATIONS = { to: '/security/rotations', label: 'Ver rotaciones' } as const;
const WHITELIST = { to: '/whitelist', label: 'Revisar la whitelist' } as const;
const ACTIVITY = { to: '/activity', label: 'Ver la actividad' } as const;
const SESSIONS = { to: '/security/sessions', label: 'Ver tus sesiones' } as const;

function field(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function addressField(payload: Record<string, unknown>, key: string): Address | null {
  const value = field(payload, key);
  return value !== null && isAddress(value, { strict: false }) ? getAddress(value) : null;
}

function dateField(payload: Record<string, unknown>, key: string): string | null {
  const value = field(payload, key);
  const date = value === null ? null : new Date(value);
  return date === null || Number.isNaN(date.getTime()) ? null : date.toLocaleString('es-AR');
}

/** Un monto que el backend manda en unidades mínimas ("1500000") o ya en unidades ("1500"). */
function amountText(value: string | null, token: string | null, minimalUnits: boolean): string | null {
  if (value === null || token === null) return null;
  try {
    // Formato de máquina del backend (punto decimal, sin miles): nunca el parser de lo que tipea el usuario.
    const units = minimalUnits ? BigInt(value) : parseDecimalAmount(value, 6);
    return `${formatAmount(units, 6)} ${token}`;
  } catch {
    return null;
  }
}

function roleText(payload: Record<string, unknown>): string {
  const role = field(payload, 'role');
  return role === null ? 'una clave de tu Safe' : (ROLE_TEXT[role] ?? role);
}

export function notificationView(notification: AppNotification, nameOf?: NameOf): NotificationView {
  const p = notification.payload;
  const text = (value: string): DescriptionPart => ({ kind: 'text', text: value });
  const party = (key: string): DescriptionPart => {
    const address = addressField(p, key);
    if (address === null) return text('(dirección no informada)');
    // El label del aviso es el del destino de la whitelist (el que escribió el usuario).
    const label = key === 'destination' ? field(p, 'label') : null;
    return { kind: 'address', address, name: label ?? nameOf?.(address) ?? null };
  };
  const view = (tone: NotificationView['tone'], parts: DescriptionPart[], link: NotificationView['link'] = null) => ({
    tone,
    parts,
    link,
  });
  switch (notification.type) {
    case 'WHITELIST_REQUESTED':
      return view(
        'warning',
        [
          text('Se pidió agregar a tu whitelist el destino '),
          party('destination'),
          text('. Si no fuiste vos, no escribas el código del email en ningún lado y cambiá tu contraseña de cuenta.'),
        ],
        WHITELIST,
      );
    case 'WHITELIST_ADDED_SOVEREIGN': {
      const at = dateField(p, 'activatesAt');
      return view(
        'warning',
        [
          text('Se agregó a tu whitelist, con tus claves U y R (fuera de la plataforma), el destino '),
          party('destination'),
          text(`${at === null ? '' : `; se activa el ${at}`}. Si no fuiste vos, quitalo antes de que se active.`),
        ],
        WHITELIST,
      );
    }
    case 'WHITELIST_ACTIVATED':
      return view('info', [text('El destino '), party('destination'), text(' ya está activo: le podés enviar.')]);
    case 'WHITELIST_REMOVED': {
      const by = field(p, 'removedBy') === 'R' ? ' con tu clave de recuperación (R)' : '';
      return view(
        'info',
        [text('Se quitó de tu whitelist el destino '), party('destination'), text(`${by}.`)],
        WHITELIST,
      );
    }
    case 'ROTATION_PROPOSED': {
      const at = dateField(p, 'executableAt');
      return view(
        'warning',
        [
          text(`Se propuso reemplazar ${roleText(p)} por la clave con la dirección `),
          party('newKey'),
          text(
            `${at === null ? '' : `; se puede ejecutar desde el ${at}`}. Si no la propusiste vos, cancelala antes de esa fecha.`,
          ),
        ],
        ROTATIONS,
      );
    }
    case 'ROTATION_READY':
      return view('info', [text(`La rotación de ${roleText(p)} ya se puede ejecutar.`)], ROTATIONS);
    case 'ROTATION_CANCELLED':
      return view('info', [text(`Se canceló la rotación de ${roleText(p)}.`)], ROTATIONS);
    case 'ROTATION_EXECUTED':
      return view('info', [
        text(`Se reemplazó ${roleText(p)}: la dirección de la clave nueva es `),
        party('newKey'),
        text('.'),
      ]);
    case 'RECOVERY_STARTED':
      return view(
        'warning',
        [
          text(
            'Se inició el reemplazo de tu clave de usuario (U) con tu clave de recuperación (R) hacia la clave con la dirección ',
          ),
          party('newKey'),
          text('. Si no fuiste vos, cancelalo desde las rotaciones.'),
        ],
        ROTATIONS,
      );
    case 'RECOVERY_ENROLLMENT_REJECTED': {
      // [F-LNK-02] (N10): la Wallet abortó un pedido de R que no pudo confirmar.
      const reason = field(p, 'reason');
      const why =
        reason === 'MANUAL_COMPARISON_FAILED'
          ? 'la dirección que copiaste de la app Recovery no coincidió con la que recibió la plataforma'
          : reason === 'RETURN_LINK_KEY_MISMATCH'
            ? 'el enlace de regreso de la app Recovery traía otra dirección de clave R'
            : 'se abrió un enlace de regreso que no armó tu app Recovery';
      const received = addressField(p, 'recoveryKey');
      return view('error', [
        text(`Se canceló un pedido para registrar tu clave de recuperación (R) porque ${why}. `),
        ...(received === null
          ? []
          : [
              text('La plataforma había recibido la dirección '),
              party('recoveryKey'),
              text(', que no quedó registrada. '),
            ]),
        text(
          'Puede ser un error al copiar, pero también que alguien haya intentado cambiar tu clave R: si no estabas registrándola, cambiá tu contraseña de cuenta.',
        ),
      ]);
    }
    case 'EXECUTOR_ROTATION_REQUESTED':
      return view('info', [text('La plataforma pidió rotar su clave (S): revisá y firmá la propuesta.')], ROTATIONS);
    case 'EXECUTOR_REPLACED':
      return view('info', [
        text('Se reemplazó la clave de la plataforma (S) por la clave con la dirección '),
        party('newKey'),
        text('.'),
      ]);
    case 'HIGH_VALUE_EXECUTED': {
      const amount = amountText(field(p, 'amount'), field(p, 'token'), false);
      return view(
        'info',
        [
          text(`Se ejecutó un envío de alto valor${amount === null ? '' : ` de ${amount}`} a `),
          party('destination'),
          text('.'),
        ],
        ACTIVITY,
      );
    }
    case 'SWAP_FAILED':
      return view(
        'error',
        [
          text(
            'Un swap no se pudo ejecutar: tus fondos no se cambiaron, pero el permiso exacto para el contrato de swap pudo haber quedado otorgado.',
          ),
        ],
        ACTIVITY,
      );
    case 'RESIDUAL_ALLOWANCE': {
      const amount = amountText(field(p, 'allowance'), field(p, 'token'), true);
      return view(
        'warning',
        [
          text(
            `Quedó un permiso${amount === null ? '' : ` de ${amount}`} para el contrato de swap de la plataforma después de un swap que no se completó.`,
          ),
        ],
        ACTIVITY,
      );
    }
    case 'SAFE_CONFIG_MODIFIED':
      return view('error', [
        text(
          'La configuración de tu Safe cambió fuera de la plataforma (con tus claves U y R): la plataforma dejó de co-firmar operaciones.',
        ),
      ]);
    case 'MIGRATION_APPROVED':
      return view('warning', [text('Se aprobó la migración excepcional de tu wallet: falta que la firmes.')], {
        to: '/security/migration',
        label: 'Ir a la migración',
      });
    case 'MIGRATION_COMPLETED':
      return view('info', [
        text('Terminó la migración: tus fondos están en tu Safe nueva '),
        party('newSafe'),
        text('.'),
      ]);
    case 'NEW_LOGIN': {
      const at = dateField(p, 'occurredAt');
      const app = field(p, 'app') === 'RECOVERY' ? 'Recovery' : 'Wallet';
      const from = field(p, 'ipPrefix');
      return view(
        'info',
        [
          text(
            `Nuevo inicio de sesión en ${app}${at === null ? '' : ` el ${at}`}${from === null ? '' : ` desde ${from}`}. Si no fuiste vos, cambiá tu contraseña de cuenta y cerrá las otras sesiones.`,
          ),
        ],
        SESSIONS,
      );
    }
    case 'PASSWORD_RESET_COMPLETED': {
      const at = dateField(p, 'occurredAt');
      return view(
        'warning',
        [
          text(
            `Se restableció la contraseña de tu cuenta${at === null ? '' : ` el ${at}`} y se cerraron tus otras sesiones. Si no fuiste vos, revisá tus sesiones y tu email.`,
          ),
        ],
        SESSIONS,
      );
    }
    default:
      // Un tipo que esta versión de la app todavía no conoce: se muestra sin el código interno.
      return view('info', [text('Aviso de la plataforma: abrí la app actualizada para ver el detalle.')]);
  }
}
