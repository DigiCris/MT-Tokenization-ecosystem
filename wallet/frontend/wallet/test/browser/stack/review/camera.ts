// Capturas de página completa numeradas en orden para el agente revisor (P17.MAN, P18.MAN), en
// <MTW_REVIEW_DIR>/<recorrido>/<navegador>/. Con los navegadores en el contenedor la captura viaja al runner. Un
// recorrido que usa otra pestaña (p. ej. la app Recovery) la captura con la misma numeración pasándola como `target`.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

export function reviewCamera(
  page: Page,
  tour: string,
  browser: string,
): (name: string, target?: Page) => Promise<void> {
  const root = process.env.MTW_REVIEW_DIR;
  if (!root) throw new Error('los recorridos de revisión necesitan MTW_REVIEW_DIR');
  const dir = join(root, tour, browser);
  mkdirSync(dir, { recursive: true });
  let shot = 0;
  return async (name: string, target: Page = page) => {
    shot += 1;
    await target.screenshot({ path: join(dir, `${String(shot).padStart(2, '0')}-${name}.png`), fullPage: true });
  };
}
