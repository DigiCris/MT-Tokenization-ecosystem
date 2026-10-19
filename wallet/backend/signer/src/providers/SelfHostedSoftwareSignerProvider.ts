// SelfHostedSoftwareSignerProvider [B-SIG-08] (staging/producción; también es la base del provider de desarrollo).
//
// - create: CSPRNG → escalar válido → contraseña derivada (HKDF de la credencial del shard) → keystore V3 → escritura
//   atómica 0400 → alta en la DB del signer. La clave nunca se devuelve ni se loguea.
// - load: al abrir, indexa el directorio y lo concilia con la DB: claves sin archivo pasan a BROKEN (alarma) y
//   archivos sin registro se reportan y nunca firman.
// - unlock: en cada firma lee el keystore, deriva la contraseña, descifra (verifica MAC y dirección), firma y
//   sobrescribe los buffers. Sin caché de claves en claro.
// - restart: el fingerprint de la credencial montada debe coincidir con el de la DB; si no, el shard queda
//   `not ready` y no firma.
import type { Kysely } from 'kysely';
import { wipe } from '../crypto/bytes.ts';
import type { Address } from '../crypto/keccak.ts';
import { generatePrivateKey, privateKeyToAddress, signDigest, type EthSignature } from '../crypto/secp256k1.ts';
import type { Secret } from '../config/secret.ts';
import { deriveKeystorePassword } from '../keystore/derive-password.ts';
import { credentialFingerprint } from '../keystore/fingerprint.ts';
import { KeystoreDirectory, KeystoreFileError } from '../keystore/keystore-dir.ts';
import { decryptKeystore, encryptKeystore, KeystoreError } from '../keystore/v3.ts';
import type { Logger } from '../observability/logger.ts';
import type { SignerMetrics } from '../observability/metrics.ts';
import { KeyRegistry, type KeyRecord } from '../state/key-registry.ts';
import type { KeyPurpose, SignerDatabase } from '../state/schema.ts';
import {
  SignerProviderError,
  type CreatedKey,
  type ProviderHealth,
  type ProviderName,
  type SignerProvider,
} from './SignerProvider.ts';

export interface SoftwareProviderOptions {
  shardId: string;
  keystoreDir: string;
  credential: Secret<Uint8Array>;
  db: Kysely<SignerDatabase>;
  logger: Logger;
  metrics?: SignerMetrics;
}

/** Estados con archivo de keystore que debe existir. */
const STATUSES_WITH_FILE = ['ACTIVE', 'RETIRED', 'MIGRATING'] as const;

export interface VerifyReport {
  verified: Address[];
  failed: { address: Address; problem: string }[];
  unexpectedFiles: string[];
}

export class SelfHostedSoftwareSignerProvider implements SignerProvider {
  readonly name: ProviderName;
  readonly shardId: string;
  readonly registry: KeyRegistry;
  readonly directory: KeystoreDirectory;
  readonly #credential: Secret<Uint8Array>;
  readonly #fingerprint: string;
  readonly #logger: Logger;
  readonly #metrics: SignerMetrics | undefined;
  #problems: string[] = [];
  #kdfVersion = 0;

  protected constructor(name: ProviderName, options: SoftwareProviderOptions) {
    this.name = name;
    this.shardId = options.shardId;
    this.registry = new KeyRegistry(options.db, options.shardId);
    this.directory = new KeystoreDirectory(options.keystoreDir);
    this.#credential = options.credential;
    this.#fingerprint = credentialFingerprint(options.credential);
    this.#logger = options.logger;
    this.#metrics = options.metrics;
  }

  /** Abre el provider de un shard ya inicializado (`pnpm shard:create`). Nunca lanza por un shard no listo. */
  static async open(options: SoftwareProviderOptions): Promise<SelfHostedSoftwareSignerProvider> {
    const provider = new SelfHostedSoftwareSignerProvider('selfhosted', options);
    await provider.initialize({ autoInitShard: false });
    return provider;
  }

  /** Inicializa el shard si se pide y no existe (sólo desarrollo) y ejecuta restart + load. */
  protected async initialize(init: { autoInitShard: boolean }): Promise<void> {
    if (init.autoInitShard && (await this.registry.shard()) === undefined) {
      this.directory.ensure();
      await this.registry.initShard({
        provider: this.name === 'development' ? 'development' : 'selfhosted',
        credentialFingerprint: this.#fingerprint,
      });
    }
    await this.reload();
  }

  get ready(): boolean {
    return this.#problems.length === 0;
  }

  get problems(): readonly string[] {
    return this.#problems;
  }

  /** restart + load: fingerprint de la credencial, permisos y conciliación directorio ↔ DB. */
  async reload(): Promise<void> {
    const problems: string[] = [];
    const shard = await this.registry.shard();
    if (shard === undefined) {
      problems.push('shard no inicializado (pnpm shard:create)');
    } else {
      this.#kdfVersion = shard.kdfVersion;
      if (shard.credentialFingerprint !== this.#fingerprint) {
        problems.push('la credencial de desbloqueo no coincide con la del shard (fingerprint distinto)');
        this.#alarm('credential_fingerprint_mismatch');
      }
    }
    let index;
    try {
      index = this.directory.index();
      problems.push(...this.directory.permissionProblems());
    } catch {
      problems.push('directorio de keystores ilegible');
    }
    if (index !== undefined && shard !== undefined) {
      const files = new Set(index.addresses.map((a) => a.toLowerCase()));
      const known = new Set<string>();
      for (const key of await this.registry.list()) {
        known.add(key.address.toLowerCase());
        const needsFile = (STATUSES_WITH_FILE as readonly string[]).includes(key.status);
        if (needsFile && !files.has(key.address.toLowerCase())) {
          await this.registry.setStatus(key.keyRef, 'BROKEN', 'KEY_BROKEN', { reason: 'archivo faltante al cargar' });
          this.#alarm('keystore_missing');
          this.#logger.error({ keyRef: key.keyRef, address: key.address }, 'keystore faltante: clave BROKEN');
        }
      }
      for (const address of index.addresses) {
        if (!known.has(address.toLowerCase())) {
          this.#alarm('keystore_unexpected');
          this.#logger.error({ address }, 'keystore sin registro en la DB del signer: no se usa para firmar');
        }
      }
      for (const name of index.unexpected) {
        this.#alarm('keystore_unexpected');
        this.#logger.error({ file: name }, 'archivo inesperado en el directorio de keystores');
      }
    }
    this.#problems = problems;
    this.#metrics?.ready.set(problems.length === 0 ? 1 : 0);
    await this.#updateKeyGauges();
    if (problems.length > 0) this.#logger.error({ problems }, 'shard no listo para firmar');
  }

  async createKey(walletId: string | null, purpose: KeyPurpose = 'EXECUTOR'): Promise<CreatedKey> {
    this.#assertReady();
    if ((purpose === 'GAS_TANK') !== (walletId === null)) {
      throw new SignerProviderError('KEY_NOT_USABLE', 'sólo la cuenta gas tank se crea sin wallet');
    }
    return this.storeKey(walletId, purpose, generatePrivateKey());
  }

  /** Cifra y guarda la clave (keystore V3) y la registra; borra la copia en claro al terminar. */
  protected async storeKey(walletId: string | null, purpose: KeyPurpose, key: Uint8Array): Promise<CreatedKey> {
    let address: Address;
    let password: Uint8Array | undefined;
    try {
      address = privateKeyToAddress(key);
      password = deriveKeystorePassword(this.#credential, address);
      this.directory.write(address, encryptKeystore(key, password));
    } finally {
      wipe(key, password);
    }
    try {
      const record = await this.registry.insertKey(this.registry.db, {
        address,
        walletId,
        purpose,
        kdfVersion: this.#kdfVersion,
        credentialFingerprint: this.#fingerprint,
      });
      this.#logger.info({ keyRef: record.keyRef, address, walletId, purpose }, 'clave creada');
      await this.#updateKeyGauges();
      return { keyRef: record.keyRef, address };
    } catch (error) {
      // Sin alta en la DB el keystore no puede quedar huérfano.
      this.directory.remove(address);
      throw error;
    }
  }

  async getAddress(keyRef: string): Promise<Address> {
    const record = await this.registry.byRef(keyRef);
    if (record === undefined) throw new SignerProviderError('KEY_NOT_FOUND', 'clave desconocida en este shard');
    return record.address;
  }

  async signDigest(keyRef: string, digest: Uint8Array): Promise<EthSignature> {
    this.#assertReady();
    if (digest.length !== 32) throw new SignerProviderError('INVALID_DIGEST', 'el digest debe tener 32 bytes');
    const record = await this.registry.byRef(keyRef);
    if (record === undefined) throw new SignerProviderError('KEY_NOT_FOUND', 'clave desconocida en este shard');
    if (record.status !== 'ACTIVE') {
      throw new SignerProviderError('KEY_NOT_USABLE', `la clave está ${record.status}`);
    }
    const key = await this.#unlock(record);
    try {
      return signDigest(digest, key);
    } finally {
      wipe(key);
    }
  }

  async health(): Promise<ProviderHealth> {
    const counts = await this.registry.counts();
    return {
      provider: this.name,
      shardId: this.shardId,
      ready: this.ready,
      problems: [...this.#problems],
      keys: { active: counts.ACTIVE ?? 0, broken: counts.BROKEN ?? 0 },
    };
  }

  /**
   * Modo `restore-verify` [B-SIG-08]: descifra cada keystore registrado y comprueba su dirección, sin firmar nada.
   * Una clave que no descifra queda BROKEN.
   */
  async verifyAll(): Promise<VerifyReport> {
    const report: VerifyReport = { verified: [], failed: [], unexpectedFiles: [] };
    const index = this.directory.index();
    const known = new Set<string>();
    for (const record of await this.registry.list([...STATUSES_WITH_FILE, 'BROKEN'])) {
      known.add(record.address.toLowerCase());
      try {
        const key = await this.#unlock(record, { markBroken: record.status !== 'BROKEN' });
        wipe(key);
        report.verified.push(record.address);
        // Un keystore restaurado desde el backup vuelve a estar disponible.
        if (record.status === 'BROKEN') {
          await this.registry.setStatus(record.keyRef, 'ACTIVE', 'KEY_RESTORED', { verifiedBy: 'restore-verify' });
        }
      } catch (error) {
        report.failed.push({ address: record.address, problem: error instanceof Error ? error.message : 'error' });
      }
    }
    for (const address of index.addresses) if (!known.has(address)) report.unexpectedFiles.push(`${address}.json`);
    report.unexpectedFiles.push(...index.unexpected);
    return report;
  }

  /** Descifra la clave de un registro. MAC inválido, dirección distinta o archivo faltante → BROKEN + alarma. */
  async #unlock(record: KeyRecord, options: { markBroken?: boolean } = {}): Promise<Uint8Array> {
    if (record.credentialFingerprint !== this.#fingerprint) {
      throw new SignerProviderError('KEY_UNAVAILABLE', 'la clave está cifrada con otra credencial');
    }
    let password: Uint8Array | undefined;
    try {
      const keystore = this.directory.read(record.address);
      password = deriveKeystorePassword(this.#credential, record.address);
      return decryptKeystore(keystore, password, record.address);
    } catch (error) {
      if (error instanceof KeystoreError || error instanceof KeystoreFileError) {
        const problem = error.problem;
        this.#alarm(problem === 'MAC' ? 'keystore_mac_invalid' : 'keystore_unreadable');
        if (options.markBroken !== false) {
          await this.registry.setStatus(record.keyRef, 'BROKEN', 'KEY_BROKEN', { reason: problem });
          await this.#updateKeyGauges();
        }
        this.#logger.error({ keyRef: record.keyRef, address: record.address, problem }, 'keystore inutilizable');
        throw new SignerProviderError('KEY_UNAVAILABLE', `keystore inutilizable (${problem})`);
      }
      throw error;
    } finally {
      wipe(password);
    }
  }

  /** Clave descifrada para los procedimientos offline del ciclo de vida (re-cifrado, migración). */
  async unlockForLifecycle(record: KeyRecord): Promise<Uint8Array> {
    return this.#unlock(record, { markBroken: false });
  }

  get credentialFingerprint(): string {
    return this.#fingerprint;
  }

  get kdfVersion(): number {
    return this.#kdfVersion;
  }

  #assertReady(): void {
    if (!this.ready) throw new SignerProviderError('NOT_READY', `shard no listo: ${this.#problems.join('; ')}`);
  }

  #alarm(alarm: string): void {
    this.#metrics?.keystoreAlarms.inc({ alarm });
  }

  async #updateKeyGauges(): Promise<void> {
    if (this.#metrics === undefined) return;
    const counts = await this.registry.counts();
    for (const status of ['ACTIVE', 'RETIRED', 'BROKEN', 'MIGRATING', 'MIGRATED', 'DESTROYED'] as const) {
      this.#metrics.keys.set({ status }, counts[status] ?? 0);
    }
  }
}
