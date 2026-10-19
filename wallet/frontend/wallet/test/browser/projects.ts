// Proyectos de Playwright por navegador: MTW_BROWSERS (lista separada por comas; por defecto, Chromium). Sin las
// dependencias de sistema de Firefox o WebKit, scripts/test-browser.mjs corre los navegadores en la imagen fijada de
// Playwright (wallet/scripts/lib/browser-server.mjs) y los tests se conectan por PW_TEST_CONNECT_WS_ENDPOINT.
import { devices, type Project } from '@playwright/test';

const DEVICES = { chromium: 'Desktop Chrome', firefox: 'Desktop Firefox', webkit: 'Desktop Safari' } as const;

function isBrowser(name: string): name is keyof typeof DEVICES {
  return Object.hasOwn(DEVICES, name);
}

export function browserProjects(): Project[] {
  const names = (process.env.MTW_BROWSERS ?? 'chromium')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return names.map((name) => {
    if (!isBrowser(name)) throw new Error(`MTW_BROWSERS: navegador desconocido ${name}`);
    return { name, use: { ...devices[DEVICES[name]] } };
  });
}
