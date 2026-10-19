// Registro estático de migraciones (orden lexicográfico por nombre). Estático en lugar de leer el directorio para que
// el build (dist/) y la ejecución directa de los .ts resuelvan exactamente el mismo conjunto.
import type { Migration } from 'kysely/migration';
import * as initialSchema from './0001_initial_schema.ts';
import * as accountPreferences from './0002_account_preferences.ts';
import * as signerKeyAttestation from './0003_signer_key_attestation.ts';
import * as walletOnboarding from './0004_wallet_onboarding.ts';
import * as operationPipeline from './0005_operation_pipeline.ts';
import * as whitelistSendSwap from './0006_whitelist_send_swap.ts';
import * as rotationsRecoveryMigration from './0007_rotations_recovery_migration.ts';
import * as executorRotationRequests from './0008_executor_rotation_requests.ts';
import * as recoveryEnrollmentRejection from './0009_recovery_enrollment_rejection.ts';

export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  '0001_initial_schema': initialSchema,
  '0002_account_preferences': accountPreferences,
  '0003_signer_key_attestation': signerKeyAttestation,
  '0004_wallet_onboarding': walletOnboarding,
  '0005_operation_pipeline': operationPipeline,
  '0006_whitelist_send_swap': whitelistSendSwap,
  '0007_rotations_recovery_migration': rotationsRecoveryMigration,
  '0008_executor_rotation_requests': executorRotationRequests,
  '0009_recovery_enrollment_rejection': recoveryEnrollmentRejection,
};
