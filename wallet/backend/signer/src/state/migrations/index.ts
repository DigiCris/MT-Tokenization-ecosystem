// Migraciones del signer, en orden. Sin "down" (expand/contract, igual que el backend pero independientes).
import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_initial.ts';

export const MIGRATIONS: Record<string, Migration> = {
  '0001_initial': m0001,
};
