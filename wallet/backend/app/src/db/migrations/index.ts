// Registro estático de migraciones (orden lexicográfico por nombre). Estático en lugar de leer el directorio para que
// el build (dist/) y la ejecución directa de los .ts resuelvan exactamente el mismo conjunto.
import type { Migration } from 'kysely/migration';
import * as initialSchema from './0001_initial_schema.ts';

export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  '0001_initial_schema': initialSchema,
};
