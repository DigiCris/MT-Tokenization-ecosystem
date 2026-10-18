// Schemas Zod del onboarding (P12) compartidos por las rutas y los servicios: metadata pública de la clave U
// ([F-KEY-03/04]), flags de backup ([F-KEY-06]) y direcciones con checksum.
import { getAddress, isAddress } from 'viem';
import { z } from 'zod';

/** Dirección EIP-55 (se acepta en cualquier capitalización válida y se normaliza a checksum). */
export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, { error: 'dirección de 20 bytes en hex' })
  .refine((v) => isAddress(v, { strict: false }), { error: 'dirección inválida' })
  .refine((v) => v !== '0x0000000000000000000000000000000000000000', { error: 'dirección cero' })
  .transform((v) => getAddress(v));

export const Bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, { error: '32 bytes en hex' })
  .transform((v) => v.toLowerCase() as `0x${string}`);

/** Firma ECDSA secp256k1 de 65 bytes (r ‖ s ‖ v) en hex. */
export const EcdsaSignatureSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, { error: 'firma de 65 bytes en hex' })
  .transform((v) => v.toLowerCase() as `0x${string}`);

/** Parámetros públicos del KDF del sobre de U ([F-KEY-03]): Argon2id 64 MiB (o 128 MiB opcional), t=3, p=4. */
export const KdfParamsSchema = z
  .object({
    alg: z.literal('argon2id'),
    version: z.literal(19),
    memoryKiB: z.union([z.literal(65_536), z.literal(131_072)]),
    iterations: z.literal(3),
    parallelism: z.literal(4),
    salt: z.string().regex(/^[A-Za-z0-9_-]{22}$/, { error: 'salt de 16 bytes en base64url' }),
  })
  .strict()
  .meta({ id: 'KdfParams', description: 'Parámetros públicos del KDF del sobre cifrado de U ([F-KEY-03])' });

/** Backups confirmados de una clave ([F-KEY-06]). */
export const StorageFlagsSchema = z
  .object({
    drive: z.boolean().describe('Google Drive appDataFolder (backup por defecto adicional)'),
    file: z.boolean().describe('Archivo cifrado descargado'),
    qr: z.boolean().describe('QR del sobre cifrado'),
    words: z.boolean().describe('17 palabras de la clave privada'),
  })
  .strict()
  .refine((f) => f.file || f.qr || f.words, {
    error: 'hace falta al menos un backup que no dependa de la plataforma (archivo, QR o 17 palabras)',
  })
  .meta({ id: 'StorageFlags', description: 'Backups confirmados de la clave ([F-KEY-06])' });

export type KdfParams = z.infer<typeof KdfParamsSchema>;
export type StorageFlags = z.infer<typeof StorageFlagsSchema>;

/** Mensaje OPAQUE en base64url (registro: pedido del cliente y registro final). */
export const OpaqueMessageSchema = z
  .string()
  .min(16)
  .max(4096)
  .regex(/^[A-Za-z0-9_-]+$/, { error: 'mensaje OPAQUE en base64url' });
