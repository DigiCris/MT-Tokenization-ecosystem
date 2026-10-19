// Violaciones de CSP y Trusted Types que ve el navegador (evento `securitypolicyviolation`), registradas desde antes de
// los scripts de la página. Se descuentan exactamente las dos que generan las pruebas de arranque de la app
// (src/security/csp-check.ts): cualquier otra es un conector o un recurso incompatible con la política.
import type { Page } from '@playwright/test';
import { EXPECTED_PROBE_VIOLATIONS } from '../../../../src/security/csp-check.ts';

export async function recordViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.defineProperty(window, '__mtwViolations', { value: seen });
    window.addEventListener('securitypolicyviolation', (event) => {
      // Chrome reporta la muestra de Trusted Types como `sink|valor`: como la app, sólo el sink o el nombre de la
      // política.
      seen.push(`${event.effectiveDirective}|${event.blockedURI}|${event.sample.split('|')[0] ?? ''}`);
    });
  });
  return async () => {
    const seen = await page.evaluate(() => (window as unknown as { __mtwViolations: string[] }).__mtwViolations);
    return seen.filter((v) => !(EXPECTED_PROBE_VIOLATIONS as readonly string[]).includes(v));
  };
}
