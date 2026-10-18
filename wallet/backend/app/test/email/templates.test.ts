// P09.T07 [B-MAIL-02/03]: snapshots de las 20 plantillas y verificación explícita de lo que exige cada email sensible:
// acción, dirección completa (EIP-55 en grupos de 4), red, Safe, expiración (hora local del usuario y UTC), origen y
// qué hacer si no fue el usuario; sin links que ejecuten acciones y con el HTML escapado.
import { describe, expect, it } from 'vitest';
import { dualTime, escapeHtml, groupedAddress, networkLabel } from '../../src/email/format.ts';
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
  'recovery-started',
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
  'high-value-challenge',
];

describe('formato', () => {
  it('dirección completa con checksum EIP-55 en grupos de 4', () => {
    expect(groupedAddress(DESTINATION)).toBe('0xd8dA 6BF2 6964 aF9D 7eEd 9e03 E534 15D3 7aA9 6045');
    expect(groupedAddress(SAFE)).toBe('0x8335 89fC D6eD b6E0 8f4c 7C32 D4f7 1b54 bdA0 2913');
    expect(() => groupedAddress('0x1234')).toThrow();
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

  it('cada oración del "si no fuiste vos" empieza en mayúscula', () => {
    for (const name of TEMPLATE_NAMES) {
      const line = /^Si no fuiste vos: (.+)$/m.exec(render(name).text)?.[1] ?? '';
      for (const sentence of line.split(/(?<=\.) /).slice(1)) expect(sentence, name).toMatch(/^[A-ZÁÉÍÓÚÑ]/);
    }
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
