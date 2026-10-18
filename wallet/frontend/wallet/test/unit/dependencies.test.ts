// P16.T02 [F-SEC-07]: la app Wallet no incluye wagmi ni conectores de wallets externas, ni como dependencia propia ni
// como transitiva en su lockfile; todas sus dependencias están fijadas con versión exacta.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT } from '../../build/config.ts';

const FORBIDDEN =
  /^(wagmi|@wagmi\/.+|@walletconnect\/.+|@reown\/.+|@coinbase\/.+|@metamask\/.+|@tanstack\/react-query|mipd|@base-org\/.+)$/;

const pkg = JSON.parse(readFileSync(resolve(APP_ROOT, 'package.json'), 'utf8')) as Record<
  'dependencies' | 'devDependencies',
  Record<string, string>
>;

/**
 * Nombres de todos los paquetes resueltos en pnpm-lock.yaml: la sección `packages` de cada documento (pnpm 12 escribe
 * primero el del propio pnpm y después el del proyecto).
 */
function lockedPackages(): string[] {
  const lock = readFileSync(resolve(APP_ROOT, 'pnpm-lock.yaml'), 'utf8');
  return lock.split(/^---$/m).flatMap((document) => {
    const start = document.indexOf('\npackages:\n');
    if (start < 0) return [];
    const end = document.indexOf('\nsnapshots:\n', start);
    const section = document.slice(start, end < 0 ? undefined : end);
    return [...section.matchAll(/^ {2}'?(@?[^@\s':]+(?:\/[^@\s':]+)?)@/gm)].map((m) => m[1] ?? '');
  });
}

describe('dependencias de Wallet', () => {
  it('ninguna dependencia propia es de wallets externas y todas tienen versión exacta', () => {
    const own = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(own).filter((name) => FORBIDDEN.test(name))).toEqual([]);
    expect(Object.entries(own).filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(version))).toEqual([]);
  });

  it('tampoco entran como transitivas (lockfile)', () => {
    const locked = lockedPackages();
    expect(locked.length).toBeGreaterThan(100);
    expect(locked).toContain('react');
    expect(locked.filter((name) => FORBIDDEN.test(name))).toEqual([]);
  });
});
