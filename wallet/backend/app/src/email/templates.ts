// Plantillas de email [B-MAIL-02/03]. Las sensibles muestran la acción, la dirección completa (EIP-55, grupos de 4),
// la red, la Safe, la expiración (hora local del usuario y UTC), la IP/dispositivo de origen y qué hacer si no fue el
// usuario. Ninguna incluye links que ejecuten acciones: los códigos se ingresan en la app (el único link es el de
// reset de password de [B-AUTH-07], que abre el formulario con el token en el fragmento). Direcciones y montos van con el
// formato de las apps (email/format.ts): la app pide compararlos con el email.
import type { AppEnv } from '../config/env.ts';
import { dualTime, escapeHtml, groupedAddress, tokenAmount } from './format.ts';

export interface RequestOrigin {
  ipPrefix: string | null;
  userAgent: string | null;
}

export interface TemplateContext {
  appEnv: AppEnv;
  locale: string;
  timeZone: string;
  product: 'Wallet' | 'Recovery';
  networkLabel: string;
}

/** Rol rotado: las tres claves de la Safe o, en un upgrade, el Guard o el guard de módulos (P15). */
type Role = 'U' | 'R' | 'S' | 'GUARD' | 'MODULE_GUARD';

export interface TemplateParams {
  'email-verification': { code: string; expiresAt: string; origin: RequestOrigin };
  'registration-attempt': { occurredAt: string; origin: RequestOrigin };
  'login-unlock': { code: string; expiresAt: string; origin: RequestOrigin };
  'password-reset': { resetUrl: string; expiresAt: string; origin: RequestOrigin };
  'password-reset-completed': { occurredAt: string; origin: RequestOrigin };
  'new-login': { occurredAt: string; origin: RequestOrigin };
  'totp-enabled': { occurredAt: string; origin: RequestOrigin };
  'totp-disabled': { occurredAt: string; origin: RequestOrigin };
  'step-up-code': { code: string; purpose: string; expiresAt: string; origin: RequestOrigin; safe?: string };
  'whitelist-challenge': {
    code: string;
    destination: string;
    label: string;
    safe: string;
    expiresAt: string;
    activationHours: number;
    origin: RequestOrigin;
  };
  'whitelist-activated': { destination: string; label: string; safe: string; occurredAt: string };
  'whitelist-removed': {
    destination: string;
    label: string;
    safe: string;
    occurredAt: string;
    removedBy: 'U' | 'R' | 'SAFE';
  };
  'rotation-proposed': {
    role: Role;
    oldKey: string;
    newKey: string;
    safe: string;
    executableAt: string;
    occurredAt: string;
    origin: RequestOrigin;
  };
  'rotation-cancelled': { role: Role; safe: string; cancelledBy: 'U' | 'R' | 'SAFE'; occurredAt: string };
  'rotation-executed': { role: Role; oldKey: string; newKey: string; safe: string; occurredAt: string };
  'executor-rotation-requested': {
    reason: 'SHARD_MIGRATION' | 'HSM_MIGRATION' | 'KEY_COMPROMISE' | 'MAINTENANCE';
    oldKey: string;
    newKey: string;
    safe: string;
    occurredAt: string;
  };
  'recovery-started': { safe: string; action: string; occurredAt: string; origin: RequestOrigin };
  'recovery-enrollment-rejected': {
    reason: RecoveryEnrollmentRejection;
    purpose: 'ONBOARDING' | 'REPLACEMENT';
    /** Dirección de R que recibió la plataforma (null si Recovery todavía no había enviado ninguna). */
    recoveryKey: string | null;
    /** Safe de la wallet (sólo en el reemplazo de R: en el onboarding todavía no existe). */
    safe: string | null;
    occurredAt: string;
    origin: RequestOrigin;
  };
  /** Los avisos de rechazo retenidos durante la ventana del usuario (un email por ventana), juntos. */
  'recovery-enrollment-rejections-summary': {
    count: number;
    /** Motivos distintos, en el orden en que llegaron. */
    reasons: RecoveryEnrollmentRejection[];
    /** true si alguno era el reemplazo de R de una wallet activa. */
    replacement: boolean;
    /** Safe, si todos son de la misma wallet activa (en el onboarding todavía no existe). */
    safe: string | null;
    firstAt: string;
    lastAt: string;
  };
  'high-value-challenge': {
    code: string;
    safe: string;
    token: 'USDC' | 'USDT';
    /** Monto en unidades mínimas del token (`1000000000` = 1.000 USDC): la plantilla lo muestra en es-AR. */
    amountUnits: string;
    destination: string;
    nonce: string;
    expiresAt: string;
    origin: RequestOrigin;
  };
  'high-value-executed': {
    safe: string;
    token: 'USDC' | 'USDT';
    /** Monto en unidades mínimas del token: la plantilla lo muestra en es-AR. */
    amountUnits: string;
    destination: string;
    txHash: string;
    occurredAt: string;
  };
  'cooperation-paused': { app: 'WALLET' | 'RECOVERY'; reason: string; occurredAt: string };
  'safe-config-modified': { safe: string; items: string[]; occurredAt: string };
  'migration-approved': { safe: string; healthy: string; occurredAt: string };
  'migration-completed': { oldSafe: string; newSafe: string; occurredAt: string };
}

export type TemplateName = keyof TemplateParams;

export const TEMPLATE_NAMES = [
  'email-verification',
  'registration-attempt',
  'login-unlock',
  'password-reset',
  'password-reset-completed',
  'new-login',
  'totp-enabled',
  'totp-disabled',
  'step-up-code',
  'whitelist-challenge',
  'whitelist-activated',
  'whitelist-removed',
  'rotation-proposed',
  'rotation-cancelled',
  'rotation-executed',
  'executor-rotation-requested',
  'recovery-started',
  'recovery-enrollment-rejected',
  'recovery-enrollment-rejections-summary',
  'high-value-challenge',
  'high-value-executed',
  'cooperation-paused',
  'safe-config-modified',
  'migration-approved',
  'migration-completed',
] as const satisfies readonly TemplateName[];

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

interface Content {
  subject: string;
  heading: string;
  intro: string;
  code?: string;
  link?: { url: string; label: string };
  details: [string, string][];
  ifNotYou: string;
}

/** Decimales de los tokens del camino asistido en Base (los mismos que fija la app). */
const TOKEN_DECIMALS: Record<'USDC' | 'USDT', number> = { USDC: 6, USDT: 6 };

/** El monto de una operación como lo muestra la app: `1.000,00 USDC`. */
const amountOf = (p: { amountUnits: string; token: 'USDC' | 'USDT' }) =>
  tokenAmount(p.amountUnits, p.token, TOKEN_DECIMALS[p.token]);

/** Los cambios de configuración de la Safe (ConfigDriftItem) en texto: el email no muestra códigos. */
const CONFIG_DRIFT_TEXT: Readonly<Record<string, string>> = {
  NOT_REGISTERED: 'la Safe ya no figura registrada en el Guard de seguridad',
  SINGLETON: 'cambió el contrato base de la Safe',
  GUARD: 'se cambió o se quitó el Guard de seguridad',
  MODULE_GUARD: 'se cambió o se quitó el guard de módulos',
  FALLBACK_HANDLER: 'se configuró un fallback handler',
  MODULES: 'se habilitaron módulos',
  THRESHOLD: 'cambió la cantidad de firmas necesarias',
  OWNERS: 'cambiaron las claves de la Safe',
};

const EXECUTOR_ROTATION_REASON_TEXT: Record<TemplateParams['executor-rotation-requested']['reason'], string> = {
  SHARD_MIGRATION: 'migración de la clave a otro servidor de firma de la plataforma',
  HSM_MIGRATION: 'migración de la clave a un módulo de hardware (HSM)',
  KEY_COMPROMISE: 'posible compromiso del servidor que guarda la clave',
  MAINTENANCE: 'mantenimiento preventivo de la clave',
};

/** Por qué la app Wallet abortó un enrollment de R ([F-LNK-02]); SUPERSEDED (pedido reemplazado) no se notifica. */
export type RecoveryEnrollmentRejection =
  'MANUAL_COMPARISON_FAILED' | 'RETURN_LINK_KEY_MISMATCH' | 'RETURN_LINK_UNVERIFIED';

const REJECTION_INTRO: Record<RecoveryEnrollmentRejection, string> = {
  MANUAL_COMPARISON_FAILED:
    'La dirección de la clave R que copiaste de la app Recovery no coincidió con la que recibió la plataforma, así que la app Wallet canceló el pedido.',
  RETURN_LINK_KEY_MISMATCH:
    'El enlace de regreso de la app Recovery traía una dirección de clave R distinta de la que recibió la plataforma, así que la app Wallet canceló el pedido.',
  RETURN_LINK_UNVERIFIED:
    'Se abrió un enlace de regreso que no armó tu app Recovery para este pedido, así que la app Wallet lo canceló.',
};
const REJECTION_REASON: Record<RecoveryEnrollmentRejection, string> = {
  MANUAL_COMPARISON_FAILED: 'la dirección copiada de la app Recovery no coincidió',
  RETURN_LINK_KEY_MISMATCH: 'el enlace de regreso traía otra dirección de clave R',
  RETURN_LINK_UNVERIFIED: 'enlace de regreso que no armó tu app Recovery',
};
/**
 * Qué pasa con la dirección de los pedidos cancelados. En el reemplazo de R la plataforma no la propone, pero una
 * rotación hacia ella se puede proponer on-chain con tus claves: si te llega un aviso así, hay que cancelarla.
 */
function rejectionOutcome(purpose: 'ONBOARDING' | 'REPLACEMENT', plural: boolean): string {
  const which = plural ? 'esos pedidos' : 'ese pedido';
  const by = plural ? 'ellos' : 'él';
  const use =
    purpose === 'ONBOARDING'
      ? `no va a usar para crear tu Safe ninguna dirección que haya llegado por ${by}`
      : `no va a proponer el reemplazo de tu clave R hacia ninguna dirección que haya llegado por ${by}`;
  const rotation =
    purpose === 'REPLACEMENT'
      ? ' Si te llega un aviso de una rotación de tu clave R que no esperabas, cancelala desde la app.'
      : '';
  return `La plataforma descartó ${which}: ${use}. Para seguir, generá un pedido nuevo desde la app Wallet.${rotation}`;
}

const ROLE_NAMES: Record<Role, string> = {
  U: 'clave de usuario (U)',
  R: 'clave de recuperación (R)',
  S: 'clave de la plataforma (S)',
  GUARD: 'Guard de seguridad de la Safe',
  MODULE_GUARD: 'guard de módulos de la Safe',
};
const ACTOR_NAMES: Record<'U' | 'R' | 'SAFE', string> = {
  U: 'tu clave de usuario',
  R: 'tu clave de recuperación',
  SAFE: 'la propia Safe',
};

function originRow(origin: RequestOrigin): [string, string] {
  const parts = [origin.ipPrefix ? `IP ${origin.ipPrefix}` : 'IP no disponible'];
  if (origin.userAgent) parts.push(origin.userAgent.slice(0, 160));
  return ['Origen', parts.join(' · ')];
}

const UTC_ZONES = new Set(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'Etc/Universal', 'Universal', 'Etc/Zulu', 'Zulu']);

function timeRows(ctx: TemplateContext, label: string, iso: string): [string, string][] {
  const t = dualTime(iso, ctx.locale, ctx.timeZone);
  // Si la zona del usuario es UTC, una sola fila (la hora local y la UTC son la misma).
  if (UTC_ZONES.has(ctx.timeZone)) return [[`${label} (UTC)`, t.utc]];
  return [
    [label, t.local],
    [`${label} (UTC)`, t.utc],
  ];
}

function compose(ctx: TemplateContext, content: Content): RenderedEmail {
  const envTag = ctx.appEnv === 'production' ? '' : `[MTW ${ctx.appEnv}] `;
  const product = ctx.product === 'Wallet' ? 'MT Wallet' : 'MT Wallet Recovery';
  const footer = [
    `${product}. Este email no incluye links que ejecuten acciones.`,
    ...(content.code ? ['Ingresá el código sólo en la app: nadie de MT Wallet te lo va a pedir.'] : []),
    ...(content.link ? ['El enlace sólo abre el formulario en la app; no ejecuta nada por sí mismo.'] : []),
  ].join(' ');
  const text = [
    content.heading,
    '',
    content.intro,
    ...(content.code ? ['', `Código: ${content.code}`] : []),
    ...(content.link ? ['', `${content.link.label}: ${content.link.url}`] : []),
    '',
    ...content.details.map(([label, value]) => `${label}: ${value}`),
    '',
    `Si no fuiste vos: ${content.ifNotYou}`,
    '',
    `— ${footer}`,
    '',
  ].join('\n');
  const rows = content.details
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top">${escapeHtml(label)}</td>` +
        `<td style="padding:4px 0;font-family:monospace">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  const html = [
    '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>',
    escapeHtml(content.subject),
    '</title></head><body style="font-family:Arial,sans-serif;color:#111;max-width:640px;margin:0 auto;padding:24px">',
    `<h1 style="font-size:20px">${escapeHtml(content.heading)}</h1>`,
    `<p>${escapeHtml(content.intro)}</p>`,
    content.code
      ? `<p style="font-size:28px;font-family:monospace;letter-spacing:4px;margin:24px 0"><strong>${escapeHtml(content.code)}</strong></p>`
      : '',
    content.link ? `<p><a href="${escapeHtml(content.link.url)}">${escapeHtml(content.link.label)}</a></p>` : '',
    `<table style="border-collapse:collapse;margin:16px 0">${rows}</table>`,
    `<p><strong>Si no fuiste vos:</strong> ${escapeHtml(content.ifNotYou)}</p>`,
    `<p style="color:#666;font-size:12px">${escapeHtml(footer)}</p>`,
    '</body></html>',
  ].join('');
  return { subject: `${envTag}${content.subject}`, text, html };
}

const CHANGE_PASSWORD_HINT =
  'cambiá tu contraseña de cuenta, revisá tus sesiones activas en la app y revocá las que no reconozcas.';
/** La misma indicación como oración nueva (después de un punto). */
const CHANGE_PASSWORD_SENTENCE = `${CHANGE_PASSWORD_HINT.charAt(0).toUpperCase()}${CHANGE_PASSWORD_HINT.slice(1)}`;

type Renderers = { [K in TemplateName]: (p: TemplateParams[K], ctx: TemplateContext) => Content };

const RENDERERS: Renderers = {
  'email-verification': (p, ctx) => ({
    subject: 'Verificá tu email',
    heading: 'Verificá tu email',
    intro: 'Ingresá este código en la app para verificar tu email.',
    code: p.code,
    details: [
      ['Acción', 'Verificación de email de la cuenta'],
      ...timeRows(ctx, 'Vence', p.expiresAt),
      originRow(p.origin),
    ],
    ifNotYou: 'ignorá este email; sin el código no se verifica ninguna cuenta.',
  }),
  'registration-attempt': (p, ctx) => ({
    subject: 'Intento de registro con tu email',
    heading: 'Alguien intentó crear una cuenta con tu email',
    intro: 'Tu email ya tiene una cuenta. Si fuiste vos, iniciá sesión o restablecé tu contraseña desde la app.',
    details: [
      ['Acción', 'Intento de registro con un email existente'],
      ...timeRows(ctx, 'Fecha', p.occurredAt),
      originRow(p.origin),
    ],
    ifNotYou: 'no tenés que hacer nada: no se creó ninguna cuenta nueva ni cambió tu contraseña.',
  }),
  'login-unlock': (p, ctx) => ({
    subject: 'Desbloqueá tu cuenta',
    heading: 'Tu cuenta quedó bloqueada por intentos fallidos',
    intro:
      'Hubo varios intentos de inicio de sesión con contraseña incorrecta. Ingresá este código en la app para desbloquearla.',
    code: p.code,
    details: [['Acción', 'Desbloqueo de la cuenta'], ...timeRows(ctx, 'Vence', p.expiresAt), originRow(p.origin)],
    ifNotYou: `alguien intentó entrar a tu cuenta. ${CHANGE_PASSWORD_SENTENCE}`,
  }),
  'password-reset': (p, ctx) => ({
    subject: 'Restablecé tu contraseña',
    heading: 'Pedido de restablecimiento de contraseña',
    intro:
      'Abrí este enlace para elegir una contraseña nueva de tu cuenta. Restablecerla cierra todas tus sesiones y no modifica tus claves de la wallet.',
    link: { url: p.resetUrl, label: 'Elegir una contraseña nueva' },
    details: [
      ['Acción', 'Restablecimiento de contraseña de la cuenta'],
      ...timeRows(ctx, 'Vence', p.expiresAt),
      originRow(p.origin),
    ],
    ifNotYou: 'ignorá este email: tu contraseña no cambia si no abrís el enlace.',
  }),
  'password-reset-completed': (p, ctx) => ({
    subject: 'Tu contraseña cambió',
    heading: 'Se restableció la contraseña de tu cuenta',
    intro: 'Se cerraron todas tus sesiones. Tus claves de la wallet no cambiaron.',
    details: [['Acción', 'Contraseña restablecida'], ...timeRows(ctx, 'Fecha', p.occurredAt), originRow(p.origin)],
    ifNotYou: 'pedí un restablecimiento nuevo y contactá a soporte de inmediato.',
  }),
  'new-login': (p, ctx) => ({
    subject: 'Nuevo inicio de sesión',
    heading: 'Nuevo inicio de sesión en tu cuenta',
    intro: 'Se inició una sesión en tu cuenta.',
    details: [['Acción', 'Inicio de sesión'], ...timeRows(ctx, 'Fecha', p.occurredAt), originRow(p.origin)],
    ifNotYou: CHANGE_PASSWORD_HINT,
  }),
  'totp-enabled': (p, ctx) => ({
    subject: 'Activaste la verificación en dos pasos',
    heading: 'Verificación en dos pasos activada',
    intro: 'Desde ahora se te va a pedir un código de tu app autenticadora al iniciar sesión.',
    details: [['Acción', 'TOTP activado'], ...timeRows(ctx, 'Fecha', p.occurredAt), originRow(p.origin)],
    ifNotYou: CHANGE_PASSWORD_HINT,
  }),
  'totp-disabled': (p, ctx) => ({
    subject: 'Desactivaste la verificación en dos pasos',
    heading: 'Verificación en dos pasos desactivada',
    intro: 'Tu cuenta ya no pide un código de app autenticadora al iniciar sesión.',
    details: [['Acción', 'TOTP desactivado'], ...timeRows(ctx, 'Fecha', p.occurredAt), originRow(p.origin)],
    ifNotYou: `${CHANGE_PASSWORD_HINT} Volvé a activar la verificación en dos pasos.`,
  }),
  'step-up-code': (p, ctx) => ({
    subject: 'Código de verificación',
    heading: 'Confirmá que sos vos',
    intro: 'Ingresá este código en la app para continuar.',
    code: p.code,
    details: [
      ['Acción', `Verificación adicional: ${p.purpose}`],
      ['Red', ctx.networkLabel],
      ...(p.safe ? ([['Safe', groupedAddress(p.safe)]] as [string, string][]) : []),
      ...timeRows(ctx, 'Vence', p.expiresAt),
      originRow(p.origin),
    ],
    ifNotYou: `no ingreses el código en ningún lado; ${CHANGE_PASSWORD_HINT}`,
  }),
  'whitelist-challenge': (p, ctx) => ({
    subject: 'Confirmá el nuevo destino autorizado',
    heading: 'Pedido para agregar un destino autorizado',
    intro: `Ingresá este código en la app para autorizar el destino. Se activa ${String(p.activationHours)} h después de confirmarse en la red; hasta entonces podés cancelarlo.`,
    code: p.code,
    details: [
      ['Acción', 'Agregar destino a la whitelist'],
      ['Dirección', groupedAddress(p.destination)],
      ['Etiqueta', p.label],
      ['Red', ctx.networkLabel],
      ['Safe', groupedAddress(p.safe)],
      ...timeRows(ctx, 'Vence', p.expiresAt),
      originRow(p.origin),
    ],
    ifNotYou: `no ingreses el código: el destino no se agrega sin él. ${CHANGE_PASSWORD_SENTENCE}`,
  }),
  'whitelist-activated': (p, ctx) => ({
    subject: 'Destino autorizado activo',
    heading: 'Un destino autorizado quedó activo',
    intro: 'Ya podés enviar fondos a este destino.',
    details: [
      ['Acción', 'Destino activado en la whitelist'],
      ['Dirección', groupedAddress(p.destination)],
      ['Etiqueta', p.label],
      ['Red', ctx.networkLabel],
      ['Safe', groupedAddress(p.safe)],
      ...timeRows(ctx, 'Fecha', p.occurredAt),
    ],
    ifNotYou: 'quitá el destino desde la app Recovery con tu clave de recuperación y contactá a soporte.',
  }),
  'whitelist-removed': (p, ctx) => ({
    subject: 'Destino autorizado eliminado',
    heading: 'Se quitó un destino autorizado',
    intro: `El destino fue eliminado por ${ACTOR_NAMES[p.removedBy]}.`,
    details: [
      ['Acción', 'Destino quitado de la whitelist'],
      ['Dirección', groupedAddress(p.destination)],
      ['Etiqueta', p.label],
      ['Red', ctx.networkLabel],
      ['Safe', groupedAddress(p.safe)],
      ...timeRows(ctx, 'Fecha', p.occurredAt),
    ],
    ifNotYou: CHANGE_PASSWORD_HINT,
  }),
  'rotation-proposed': (p, ctx) => ({
    subject: 'Propuesta de rotación de clave',
    heading: `Se propuso rotar tu ${ROLE_NAMES[p.role]}`,
    intro:
      'La rotación se puede ejecutar recién cuando termine el plazo de 48 h. Hasta entonces podés cancelarla con tu clave de usuario o tu clave de recuperación.',
    details: [
      ['Acción', `Rotación de ${ROLE_NAMES[p.role]}`],
      ['Clave actual', groupedAddress(p.oldKey)],
      ['Clave nueva', groupedAddress(p.newKey)],
      ['Red', ctx.networkLabel],
      ['Safe', groupedAddress(p.safe)],
      ...timeRows(ctx, 'Ejecutable desde', p.executableAt),
      ...timeRows(ctx, 'Propuesta', p.occurredAt),
      originRow(p.origin),
    ],
    ifNotYou: 'cancelá la rotación desde la app (Wallet o Recovery) antes del plazo y contactá a soporte.',
  }),
  'rotation-cancelled': (p, ctx) => ({
    subject: 'Rotación de clave cancelada',
    heading: `Se canceló la rotación de tu ${ROLE_NAMES[p.role]}`,
    intro: `La cancelación la hizo ${ACTOR_NAMES[p.cancelledBy]}.`,
    details: [
      ['Acción', `Cancelación de la rotación de ${ROLE_NAMES[p.role]}`],
      ['Red', ctx.networkLabel],
      ['Safe', groupedAddress(p.safe)],
      ...timeRows(ctx, 'Fecha', p.occurredAt),
    ],
    ifNotYou: 'revisá la propuesta en la app y contactá a soporte.',
  }),
  'rotation-executed': (p, ctx) => ({
    subject: 'Rotación de clave ejecutada',
    heading: `Se rotó tu ${ROLE_NAMES[p.role]}`,
    intro: 'La clave anterior ya no tiene control sobre la Safe.',
    details: [
      ['Acción', `Rotación ejecutada de ${ROLE_NAMES[p.role]}`],
      ['Clave anterior', groupedAddress(p.oldKey)],
      ['Clave nueva', groupedAddress(p.newKey)],
      ['Red', ctx.networkLabel],
      ['Safe', groupedAddress(p.safe)],
      ...timeRows(ctx, 'Fecha', p.occurredAt),
    ],
    ifNotYou: 'usá tu otra clave para proponer la rotación de vuelta y contactá a soporte de inmediato.',
  }),
  'executor-rotation-requested': (p, ctx) => ({
    subject: 'La plataforma pidió rotar su clave de tu Safe',
    heading: 'Hay que rotar la clave de la plataforma (S)',
    intro: `Motivo: ${EXECUTOR_ROTATION_REASON_TEXT[p.reason]}. Entrá a la app Wallet, revisá la clave nueva y firmá la propuesta: se puede ejecutar después de 48 h y hasta entonces la podés cancelar. Mientras tanto tu wallet sigue operando con la clave actual.`,
    details: [
      ['Acción', `Pedido de rotación de ${ROLE_NAMES.S}`],
      ['Motivo', EXECUTOR_ROTATION_REASON_TEXT[p.reason]],
      ['Clave actual', groupedAddress(p.oldKey)],
      ['Clave nueva', groupedAddress(p.newKey)],
      ['Red', ctx.networkLabel],
      ['Safe', groupedAddress(p.safe)],
      ...timeRows(ctx, 'Fecha', p.occurredAt),
    ],
    ifNotYou: 'este pedido lo inicia la plataforma; si no lo esperabas, no firmes nada y contactá a soporte.',
  }),
  'recovery-started': (p, ctx) => ({
    subject: 'Se inició un proceso de recuperación',
    heading: 'Proceso de recuperación iniciado',
    intro: `Se inició: ${p.action}.`,
    details: [
      ['Acción', p.action],
      ['Red', ctx.networkLabel],
      ['Safe', groupedAddress(p.safe)],
      ...timeRows(ctx, 'Fecha', p.occurredAt),
      originRow(p.origin),
    ],
    ifNotYou: 'cancelá desde la app con tu clave de usuario y contactá a soporte.',
  }),
  'recovery-enrollment-rejected': (p, ctx) => ({
    subject: 'Posible sustitución de tu clave R',
    heading: 'Cancelamos un pedido para registrar tu clave de recuperación (R)',
    intro: `${REJECTION_INTRO[p.reason]} Puede ser un error al copiar, pero también que alguien haya intentado cambiar tu clave R en el camino. ${rejectionOutcome(p.purpose, false)}`,
    details: [
      [
        'Acción',
        p.purpose === 'REPLACEMENT'
          ? `Cancelación del reemplazo de tu ${ROLE_NAMES.R}`
          : `Cancelación del registro de tu ${ROLE_NAMES.R}`,
      ],
      ['Motivo', REJECTION_REASON[p.reason]],
      ...(p.recoveryKey === null
        ? []
        : ([['Dirección que recibió la plataforma', groupedAddress(p.recoveryKey)]] as [string, string][])),
      ['Red', ctx.networkLabel],
      ...(p.safe === null ? [] : ([['Safe', groupedAddress(p.safe)]] as [string, string][])),
      ...timeRows(ctx, 'Fecha', p.occurredAt),
      originRow(p.origin),
    ],
    ifNotYou: `si no estabas registrando tu clave R, ${CHANGE_PASSWORD_HINT} No abras enlaces de regreso de la app Recovery que te lleguen por email o por chat.`,
  }),
  'recovery-enrollment-rejections-summary': (p, ctx) => {
    const more = p.count === 1 ? 'otro pedido' : `${String(p.count)} pedidos más`;
    return {
      subject: 'Más pedidos de tu clave R cancelados',
      heading: `Cancelamos ${more} para registrar tu clave de recuperación (R)`,
      intro: `Después de nuestro último aviso, la app Wallet canceló ${more} porque no pudo confirmar la dirección de tu clave R. Para no llenarte de emails te los mandamos juntos: el detalle de cada uno está en los avisos de la app Wallet. Puede ser un error al copiar, pero también que alguien haya intentado cambiar tu clave R en el camino. ${rejectionOutcome(p.replacement ? 'REPLACEMENT' : 'ONBOARDING', p.count > 1)}`,
      details: [
        ['Acción', `Cancelación de pedidos de tu ${ROLE_NAMES.R}`],
        ['Pedidos cancelados', String(p.count)],
        ['Motivos', p.reasons.map((reason) => REJECTION_REASON[reason]).join('; ')],
        ['Red', ctx.networkLabel],
        ...(p.safe === null ? [] : ([['Safe', groupedAddress(p.safe)]] as [string, string][])),
        ...timeRows(ctx, 'Primero', p.firstAt),
        ...timeRows(ctx, 'Último', p.lastAt),
      ],
      ifNotYou: `si no estabas registrando tu clave R, ${CHANGE_PASSWORD_HINT} No abras enlaces de regreso de la app Recovery que te lleguen por email o por chat.`,
    };
  },
  'high-value-challenge': (p, ctx) => ({
    subject: 'Confirmá una operación de alto valor',
    heading: 'Confirmá el envío',
    intro:
      'Ingresá este código en la app para autorizar esta operación. El código sólo sirve para esta operación exacta.',
    code: p.code,
    details: [
      ['Acción', `Envío de ${amountOf(p)}`],
      ['Destino', groupedAddress(p.destination)],
      ['Red', ctx.networkLabel],
      ['Safe', groupedAddress(p.safe)],
      ['Nonce de la Safe', p.nonce],
      ...timeRows(ctx, 'Vence', p.expiresAt),
      originRow(p.origin),
    ],
    ifNotYou: `no ingreses el código y cancelá la operación desde la app. ${CHANGE_PASSWORD_SENTENCE}`,
  }),
  'high-value-executed': (p, ctx) => ({
    subject: 'Operación de alto valor ejecutada',
    heading: 'Se ejecutó un envío de alto valor',
    intro: `Se enviaron ${amountOf(p)}.`,
    details: [
      ['Acción', `Envío de ${amountOf(p)}`],
      ['Destino', groupedAddress(p.destination)],
      ['Red', ctx.networkLabel],
      ['Safe', groupedAddress(p.safe)],
      ['Transacción', p.txHash],
      ...timeRows(ctx, 'Fecha', p.occurredAt),
    ],
    ifNotYou: 'quitá los destinos que no reconozcas desde la app Recovery y contactá a soporte.',
  }),
  'cooperation-paused': (p, ctx) => ({
    subject: 'Pausa preventiva de operaciones',
    heading: 'Pausamos la cooperación de la plataforma',
    intro: `El monitor de integridad detectó un problema en la app ${p.app === 'WALLET' ? 'Wallet' : 'Recovery'}: ${p.reason}. Mientras dure la pausa no se co-firman operaciones; tus fondos siguen bajo tu control con tus claves U y R.`,
    details: [
      ['Acción', 'Pausa de cooperación de S'],
      ['Red', ctx.networkLabel],
      ...timeRows(ctx, 'Desde', p.occurredAt),
    ],
    ifNotYou: 'no tenés que hacer nada; no ingreses tus claves en sitios que no sean los oficiales.',
  }),
  'safe-config-modified': (p, ctx) => ({
    subject: 'La configuración de tu Safe cambió fuera de la plataforma',
    heading: 'Tu Safe ya no está en modo asistido',
    intro:
      'La configuración on-chain de tu Safe ya no es la de una wallet asistida (por ejemplo, se retiró el Guard de seguridad firmando con tus claves U y R). Sin el Guard no hay control on-chain de las operaciones, así que la plataforma dejó de co-firmar; tus fondos siguen bajo tu control con tus claves U y R.',
    details: [
      ['Acción', 'Cambio de configuración de la Safe'],
      ['Cambios detectados', p.items.map((item) => CONFIG_DRIFT_TEXT[item] ?? `código interno ${item}`).join('; ')],
      ['Red', ctx.networkLabel],
      ['Safe', groupedAddress(p.safe)],
      ...timeRows(ctx, 'Detectado', p.occurredAt),
    ],
    ifNotYou:
      'usá tus claves U y R desde la app Recovery para restaurar la configuración o mover tus fondos a otra wallet, y contactá a soporte de inmediato.',
  }),
  'migration-approved': (p, ctx) => ({
    subject: 'Se aprobó la migración de tu wallet',
    heading: 'Migración excepcional aprobada',
    intro: `Dos operadores aprobaron mover tus fondos a una Safe nueva donde ${p.healthy} conserva su rol. Hasta que termine, la plataforma sólo co-firma la migración desde tu Safe actual; la transferencia la firmás vos con esa clave, después de que la autorización on-chain cumpla su plazo de 24 h.`,
    details: [
      ['Acción', 'Migración excepcional de la wallet'],
      ['Credencial sana', p.healthy],
      ['Red', ctx.networkLabel],
      ['Safe actual', groupedAddress(p.safe)],
      ...timeRows(ctx, 'Aprobada', p.occurredAt),
    ],
    ifNotYou: 'contactá a soporte de inmediato: sin tu firma con la credencial sana los fondos no se mueven.',
  }),
  'migration-completed': (p, ctx) => ({
    subject: 'Migración de tu wallet completada',
    heading: 'Tus fondos están en la Safe nueva',
    intro: 'La Safe anterior quedó sin saldo y fuera de uso: desde ahora operá con la Safe nueva.',
    details: [
      ['Acción', 'Migración completada'],
      ['Safe anterior', groupedAddress(p.oldSafe)],
      ['Safe nueva', groupedAddress(p.newSafe)],
      ['Red', ctx.networkLabel],
      ...timeRows(ctx, 'Fecha', p.occurredAt),
    ],
    ifNotYou: 'contactá a soporte de inmediato.',
  }),
};

export function renderTemplate<K extends TemplateName>(
  name: K,
  params: TemplateParams[K],
  ctx: TemplateContext,
): RenderedEmail {
  const renderer = RENDERERS[name] as (p: TemplateParams[K], c: TemplateContext) => Content;
  return compose(ctx, renderer(params, ctx));
}
