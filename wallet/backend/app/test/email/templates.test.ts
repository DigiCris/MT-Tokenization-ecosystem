// P09.T07 [B-MAIL-02/03]: snapshots de las plantillas y verificación explícita de lo que exige cada email sensible:
// acción, dirección completa (EIP-55 en grupos de 4), red, Safe, expiración (hora local del usuario y UTC), origen y
// qué hacer si no fue el usuario; sin links que ejecuten acciones y con el HTML escapado. P18.MAN: direcciones y montos
// con el formato de las apps (`0x ` y 10 grupos de 4; montos es-AR con su token), que es lo que la app pide comparar.
import { describe, expect, it } from 'vitest';
import { dualTime, escapeHtml, groupedAddress, networkLabel, tokenAmount } from '../../src/email/format.ts';
import { renderTemplate, TEMPLATE_NAMES, type TemplateContext, type TemplateName } from '../../src/email/templates.ts';
import { DESTINATION, NEW_KEY, OLD_KEY, SAFE, TEMPLATE_FIXTURES } from '../helpers/email-fixtures.ts';

const CTX: TemplateContext = {
  appEnv: 'production',
  locale: 'es-AR',
  timeZone: 'America/Argentina/Buenos_Aires',
  product: 'Wallet',
  networkLabel: 'Base mainnet — chainId 8453',
};

const render = (name: TemplateName, ctx: Partial<TemplateContext> = {}) =>
  renderTemplate(name, TEMPLATE_FIXTURES[name] as never, { ...CTX, ...ctx });

/** Plantillas de [B-MAIL-02] que operan sobre la Safe: red y Safe obligatorias. */
const SAFE_TEMPLATES: TemplateName[] = [
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
  'high-value-challenge',
  'high-value-executed',
  'safe-config-modified',
];
const WITH_DESTINATION: TemplateName[] = [
  'whitelist-challenge',
  'whitelist-activated',
  'whitelist-removed',
  'high-value-challenge',
  'high-value-executed',
];
const WITH_EXPIRY: TemplateName[] = [
  'email-verification',
  'login-unlock',
  'password-reset',
  'step-up-code',
  'whitelist-challenge',
  'high-value-challenge',
];
const WITH_ORIGIN: TemplateName[] = [
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
  'rotation-proposed',
  'recovery-started',
  'recovery-enrollment-rejected',
  'high-value-challenge',
];

describe('formato', () => {
  it('dirección completa con checksum EIP-55 como en las apps: "0x " y los 10 grupos de 4', () => {
    expect(groupedAddress(DESTINATION)).toBe('0x d8dA 6BF2 6964 aF9D 7eEd 9e03 E534 15D3 7aA9 6045');
    expect(groupedAddress(SAFE)).toBe('0x 8335 89fC D6eD b6E0 8f4c 7C32 D4f7 1b54 bdA0 2913');
    expect(groupedAddress(DESTINATION).split(' ')).toHaveLength(11);
    expect(() => groupedAddress('0x1234')).toThrow();
  });

  it('montos en es-AR con su token, como en las apps: miles con punto y al menos 2 decimales, sin perder precisión', () => {
    expect(tokenAmount('1000000000', 'USDC', 6)).toBe('1.000,00 USDC');
    expect(tokenAmount(1_500_000_000n, 'USDC', 6)).toBe('1.500,00 USDC');
    expect(tokenAmount('12345678901', 'USDT', 6)).toBe('12.345,678901 USDT');
    expect(tokenAmount('1500000', 'USDC', 6)).toBe('1,50 USDC');
    expect(tokenAmount('1', 'USDC', 6)).toBe('0,000001 USDC');
    expect(tokenAmount('0', 'USDC', 6)).toBe('0,00 USDC');
    // Sólo unidades mínimas: un monto ya formateado (o con decimales) es un error de quien arma el email.
    for (const wrong of ['12.500,00', '1000.5', '1,5', '-1', '']) {
      expect(() => tokenAmount(wrong, 'USDC', 6), wrong).toThrow();
    }
    expect(() => tokenAmount(-1n, 'USDC', 6)).toThrow();
  });

  it('hora local del usuario y UTC', () => {
    expect(dualTime('2026-10-17T15:04:05.000Z', 'es-AR', 'America/Argentina/Buenos_Aires')).toEqual({
      local: '17/10/2026, 12:04 (America/Argentina/Buenos_Aires)',
      utc: '17/10/2026, 15:04 UTC',
    });
  });

  it('red: fork en local, mainnet fuera de local, o la etiqueta configurada', () => {
    expect(networkLabel('local')).toBe('Base fork local — chainId 8453');
    expect(networkLabel('staging')).toBe('Base mainnet — chainId 8453');
    expect(networkLabel('production')).toBe('Base mainnet — chainId 8453');
    expect(networkLabel('staging', 'Base fork staging — chainId 8453')).toBe('Base fork staging — chainId 8453');
  });

  it('escapa HTML', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('snapshots', () => {
  it.each(TEMPLATE_NAMES)('%s', (name) => {
    expect(render(name)).toMatchSnapshot();
  });
});

describe('contenido obligatorio', () => {
  it.each(TEMPLATE_NAMES)('%s: acción, qué hacer si no fuiste vos y pie sin links de acción', (name) => {
    const email = render(name);
    expect(email.subject.length).toBeGreaterThan(5);
    expect(email.text).toMatch(/^Acción: .+$/m);
    expect(email.text).toMatch(/^Si no fuiste vos: .+$/m);
    expect(email.text).toContain('Este email no incluye links que ejecuten acciones');
    expect(email.html.startsWith('<!doctype html><html lang="es">')).toBe(true);
    // El único link de todos los emails es el de reset de password (abre el formulario; el token va en el fragmento).
    expect(email.text.includes('Ingresá el código sólo en la app')).toBe(/^Código: /m.test(email.text));
    if (name === 'password-reset') {
      expect(email.html.match(/<a /g)).toHaveLength(1);
      expect(email.text).toContain('/reset-password#token=');
      expect(email.text).toContain('El enlace sólo abre el formulario en la app');
    } else {
      expect(email.html).not.toContain('<a ');
      expect(email.text).not.toMatch(/https?:\/\//);
    }
  });

  it.each(SAFE_TEMPLATES)('%s: red y Safe completa', (name) => {
    const { text } = render(name);
    expect(text).toContain('Red: Base mainnet — chainId 8453');
    expect(text).toContain(`Safe: ${groupedAddress(SAFE)}`);
  });

  it.each(WITH_DESTINATION)('%s: dirección de destino completa', (name) => {
    const { text, html } = render(name);
    expect(text).toContain(groupedAddress(DESTINATION));
    expect(html).toContain(groupedAddress(DESTINATION));
  });

  it.each(WITH_EXPIRY)('%s: expiración en hora local y UTC', (name) => {
    const { text } = render(name);
    expect(text).toMatch(/^Vence: \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2} \(America\/Argentina\/Buenos_Aires\)$/m);
    expect(text).toMatch(/^Vence \(UTC\): \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2} UTC$/m);
  });

  it('con la zona horaria UTC muestra una sola fila de hora (local y UTC coinciden)', () => {
    const { text } = render('email-verification', { timeZone: 'UTC' });
    expect(text).toMatch(/^Vence \(UTC\): 17\/10\/2026, 15:19 UTC$/m);
    expect(text).not.toMatch(/^Vence: /m);
  });

  it.each(WITH_ORIGIN)('%s: IP y dispositivo de origen', (name) => {
    expect(render(name).text).toContain('Origen: IP 203.0.113.0/24 · Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0');
  });

  it('rotaciones: clave actual y nueva completas y plazo de ejecución', () => {
    const { text } = render('rotation-proposed');
    expect(text).toContain(`Clave actual: ${groupedAddress(OLD_KEY)}`);
    expect(text).toContain(`Clave nueva: ${groupedAddress(NEW_KEY)}`);
    expect(text).toMatch(/^Ejecutable desde: 19\/10\/2026, 12:04 \(America\/Argentina\/Buenos_Aires\)$/m);
    expect(text).toContain('48 h');
  });

  it('rechazo de un enrollment de R (P17.MAN, N10): posible sustitución, motivo, dirección recibida y qué hacer', () => {
    const { subject, text } = render('recovery-enrollment-rejected');
    expect(subject).toBe('Posible sustitución de tu clave R');
    expect(text).toContain('El enlace de regreso de la app Recovery traía una dirección de clave R distinta');
    expect(text).toContain('alguien haya intentado cambiar tu clave R en el camino');
    expect(text).toContain('Acción: Cancelación del reemplazo de tu clave de recuperación (R)');
    expect(text).toContain(`Dirección que recibió la plataforma: ${groupedAddress(NEW_KEY)}`);
    expect(text).toContain('No abras enlaces de regreso de la app Recovery que te lleguen por email o por chat.');
    // En el onboarding no hay Safe todavía, y si Recovery no había enviado R no hay dirección que mostrar.
    const onboarding = renderTemplate(
      'recovery-enrollment-rejected',
      {
        reason: 'RETURN_LINK_UNVERIFIED',
        purpose: 'ONBOARDING',
        recoveryKey: null,
        safe: null,
        occurredAt: '2026-10-17T15:04:05.000Z',
        origin: { ipPrefix: null, userAgent: null },
      },
      CTX,
    ).text;
    expect(onboarding).toContain('Se abrió un enlace de regreso que no armó tu app Recovery para este pedido');
    expect(onboarding).toContain('Acción: Cancelación del registro de tu clave de recuperación (R)');
    expect(onboarding).not.toMatch(/^Safe: /m);
    expect(onboarding).not.toContain('Dirección que recibió la plataforma');
    expect(
      renderTemplate(
        'recovery-enrollment-rejected',
        { ...TEMPLATE_FIXTURES['recovery-enrollment-rejected'], reason: 'MANUAL_COMPARISON_FAILED' },
        CTX,
      ).text,
    ).toContain('Motivo: la dirección copiada de la app Recovery no coincidió');
    // Lo que pasa con la dirección es veraz también si después se propone on-chain (revisión de ADR-033): la plataforma
    // no la usa ni la propone, y en el reemplazo de R se pide cancelar una rotación que no se esperaba.
    expect(text).not.toContain('no quedó registrada');
    expect(text).toContain(
      'no va a proponer el reemplazo de tu clave R hacia ninguna dirección que haya llegado por él',
    );
    expect(text).toContain(
      'Si te llega un aviso de una rotación de tu clave R que no esperabas, cancelala desde la app.',
    );
    expect(onboarding).toContain('no va a usar para crear tu Safe ninguna dirección que haya llegado por él');
    expect(onboarding).not.toContain('rotación');
  });

  it('resumen de los rechazos retenidos de la ventana (revisión de ADR-033): cuántos, motivos, Safe y desde cuándo', () => {
    const { subject, text } = render('recovery-enrollment-rejections-summary');
    expect(subject).toBe('Más pedidos de tu clave R cancelados');
    expect(text).toContain('Cancelamos 3 pedidos más para registrar tu clave de recuperación (R)');
    expect(text).toContain('Para no llenarte de emails te los mandamos juntos');
    expect(text).toContain('Pedidos cancelados: 3');
    expect(text).toContain(
      'Motivos: la dirección copiada de la app Recovery no coincidió; enlace de regreso que no armó tu app Recovery',
    );
    expect(text).toContain(`Safe: ${groupedAddress(SAFE)}`);
    expect(text).toMatch(/^Primero: 17\/10\/2026, 12:04 \(America\/Argentina\/Buenos_Aires\)$/m);
    expect(text).toMatch(/^Último \(UTC\): 17\/10\/2026, 15:40 UTC$/m);
    expect(text).toContain(
      'La plataforma descartó esos pedidos: no va a proponer el reemplazo de tu clave R hacia ninguna dirección que haya llegado por ellos.',
    );
    expect(text).toContain('Si te llega un aviso de una rotación de tu clave R que no esperabas, cancelala');
    const single = renderTemplate(
      'recovery-enrollment-rejections-summary',
      {
        ...TEMPLATE_FIXTURES['recovery-enrollment-rejections-summary'],
        count: 1,
        reasons: ['RETURN_LINK_KEY_MISMATCH'],
        replacement: false,
        safe: null,
      },
      CTX,
    ).text;
    expect(single).toContain('Cancelamos otro pedido para registrar tu clave de recuperación (R)');
    expect(single).not.toMatch(/^Safe: /m);
    expect(single).toContain(
      'La plataforma descartó ese pedido: no va a usar para crear tu Safe ninguna dirección que haya llegado por él.',
    );
  });

  it('cada oración del "si no fuiste vos" empieza en mayúscula', () => {
    for (const name of TEMPLATE_NAMES) {
      const line = /^Si no fuiste vos: (.+)$/m.exec(render(name).text)?.[1] ?? '';
      for (const sentence of line.split(/(?<=\.) /).slice(1)) expect(sentence, name).toMatch(/^[A-ZÁÉÍÓÚÑ]/);
    }
  });

  it('alto valor: el monto en es-AR con su token y el destino agrupado como en la app', () => {
    const challenge = render('high-value-challenge');
    expect(challenge.text).toContain('Acción: Envío de 12.500,00 USDC');
    expect(challenge.text).toContain('Destino: 0x d8dA 6BF2 6964 aF9D 7eEd 9e03 E534 15D3 7aA9 6045');
    expect(challenge.html).toContain('Envío de 12.500,00 USDC');
    const executed = render('high-value-executed');
    expect(executed.text).toContain('Se enviaron 12.500,25 USDT.');
    expect(executed.text).toContain('Acción: Envío de 12.500,25 USDT');
  });

  it('los cambios de configuración de la Safe van en texto, sin códigos internos', () => {
    const { text } = render('safe-config-modified');
    expect(text).toContain(
      'Cambios detectados: se cambió o se quitó el Guard de seguridad; se cambió o se quitó el guard de módulos',
    );
    expect(text).not.toMatch(/\bMODULE_GUARD\b/);
  });

  it('los códigos van en el cuerpo con el formato que se ingresa en la app', () => {
    expect(render('email-verification').text).toContain('Código: 48213907');
    expect(render('login-unlock').text).toContain('Código: 00912345');
    expect(render('high-value-challenge').text).toContain('Código: 27182818');
  });

  it('el HTML escapa los datos variables (etiquetas, user agents)', () => {
    const { html, text } = render('whitelist-challenge');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Cuenta de &lt;script&gt;alert(1)&lt;/script&gt; Ana');
    expect(text).toContain('Etiqueta: Cuenta de <script>alert(1)</script> Ana');
  });

  it('fuera de producción el asunto lleva el entorno; Recovery firma con su producto; la red sigue al contexto', () => {
    expect(render('new-login', { appEnv: 'staging' }).subject).toBe('[MTW staging] Nuevo inicio de sesión');
    expect(render('new-login', { appEnv: 'local' }).subject).toBe('[MTW local] Nuevo inicio de sesión');
    expect(render('new-login').subject).toBe('Nuevo inicio de sesión');
    expect(render('password-reset', { product: 'Recovery' }).text).toContain('— MT Wallet Recovery.');
    expect(render('whitelist-activated', { networkLabel: 'Base fork local — chainId 8453' }).text).toContain(
      'Red: Base fork local — chainId 8453',
    );
  });
});
