// Ciclo del integrity monitor (P20.T02–T04): cada `intervalSeconds` chequea cada app (check.ts), aplica la pausa
// pegajosa por MISMATCH, levanta la pausa sólo con el release otra vez OK y dos aprobaciones de operadores distintos
// para ese release exacto, y firma una IntegrityAttestation por app con vencimiento `attestationTtlSeconds`.
import type { KeyObject } from 'node:crypto';
import { approvalProblem, type ResumeApproval } from './approvals.ts';
import { signAttestation, type AttestationEnvironment, type IntegrityAttestation } from './attestation.ts';
import { APPS, checkRelease, type App, type CheckResult, type Target } from './check.ts';
import type { StateStore } from './state.ts';

export interface MonitorEvents {
  checked?: (app: App, result: CheckResult, attested: IntegrityAttestation) => void;
  paused?: (app: App, problems: string[]) => void;
  resumed?: (app: App, operators: string[]) => void;
}

export interface MonitorOptions {
  platformId: string;
  /** Entorno del manifest de las apps (local, ci, staging, production). */
  manifestEnvironment: string;
  /** Entorno de la plataforma en la atestación (el APP_ENV del signer). */
  attestationEnvironment: AttestationEnvironment;
  targets: readonly Target[];
  releaseKeys: Readonly<Record<App, readonly KeyObject[]>>;
  attestationKey: KeyObject;
  operatorKeys: ReadonlyMap<string, KeyObject>;
  attestationTtlSeconds: number;
  fetchTimeoutMs: number;
  state: StateStore;
  fetch?: typeof fetch;
  now?: () => number;
  events?: MonitorEvents;
}

export class ApprovalRejected extends Error {
  override name = 'ApprovalRejected';
}

export class IntegrityMonitor {
  readonly #o: MonitorOptions;
  readonly #tokens = new Map<App, { token: string; attestation: IntegrityAttestation }>();

  constructor(options: MonitorOptions) {
    this.#o = options;
  }

  #now(): number {
    return Math.floor((this.#o.now?.() ?? Date.now()) / 1000);
  }

  /** Un ciclo: chequea las apps configuradas en paralelo y renueva sus atestaciones. */
  async runCycle(): Promise<void> {
    await Promise.all(this.#o.targets.map((target) => this.#checkApp(target)));
  }

  async #checkApp(target: Target): Promise<void> {
    const result = await checkRelease(target, {
      releaseKeys: this.#o.releaseKeys[target.app],
      environment: this.#o.manifestEnvironment,
      timeoutMs: this.#o.fetchTimeoutMs,
      ...(this.#o.fetch === undefined ? {} : { fetch: this.#o.fetch }),
    });
    const state = this.#o.state.get(target.app);
    const now = this.#now();
    state.lastCheck = result;
    state.lastCheckAt = now;
    if (result.status === 'OK') state.lastOkAt = now;
    if (result.status === 'MISMATCH') {
      if (!state.paused) {
        state.paused = true;
        state.pausedAt = now;
        state.pauseProblems = result.problems.slice(0, 20);
        state.approvals = [];
        this.#o.state.save();
        this.#o.events?.paused?.(target.app, state.pauseProblems);
      }
    } else if (state.paused) {
      this.#tryResume(target.app);
    }
    state.status = state.paused ? 'MISMATCH' : result.status;
    this.#attest(target.app, result);
  }

  /** Levanta la pausa si el último chequeo es OK y hay dos aprobaciones válidas de operadores distintos para él. */
  #tryResume(app: App): void {
    const state = this.#o.state.get(app);
    const check = state.lastCheck;
    if (check?.status !== 'OK' || check.releaseId === null || check.manifestSha256 === null) return;
    const expected = { app, releaseId: check.releaseId, manifestSha256: `0x${check.manifestSha256}` };
    const context = { ...this.#context(), operatorKeys: this.#o.operatorKeys, now: this.#now() };
    const valid = state.approvals.filter((a) => approvalProblem(a, context, expected) === null);
    const operators = [...new Set(valid.map((a) => a.operatorId))];
    if (operators.length < 2) return;
    state.paused = false;
    state.pausedAt = null;
    state.pauseProblems = [];
    state.approvals = [];
    state.resumedAt = this.#now();
    state.resumedBy = operators;
    state.status = 'OK';
    this.#o.state.save();
    this.#o.events?.resumed?.(app, operators);
    this.#attest(app, check);
  }

  #context() {
    return { platformId: this.#o.platformId, environment: this.#o.attestationEnvironment };
  }

  #attest(app: App, result: CheckResult): void {
    const state = this.#o.state.get(app);
    const observedAt = this.#now();
    const attestation: IntegrityAttestation = {
      platformId: this.#o.platformId,
      app,
      environment: this.#o.attestationEnvironment,
      releaseId: result.releaseId ?? 'unknown',
      manifestSha256: `0x${result.manifestSha256 ?? '0'.repeat(64)}`,
      status: state.status,
      observedAt,
      expiresAt: observedAt + this.#o.attestationTtlSeconds,
    };
    this.#tokens.set(app, { token: signAttestation(attestation, this.#o.attestationKey), attestation });
    this.#o.events?.checked?.(app, result, attestation);
  }

  /**
   * Suma una aprobación de reanudación (verificada contra el último chequeo de la app) y, si con ella se completan dos
   * operadores distintos y el chequeo es OK, reanuda en el acto. Devuelve si quedó reanudada.
   */
  approve(approval: ResumeApproval): { resumed: boolean; approvals: number } {
    const state = this.#o.state.get(approval.app);
    if (!state.paused) throw new ApprovalRejected('la app no está pausada');
    const check = state.lastCheck;
    if (check?.status !== 'OK' || check.releaseId === null || check.manifestSha256 === null) {
      throw new ApprovalRejected('el release servido todavía no verifica (el último chequeo no es OK)');
    }
    const problem = approvalProblem(
      approval,
      { ...this.#context(), operatorKeys: this.#o.operatorKeys, now: this.#now() },
      { app: approval.app, releaseId: check.releaseId, manifestSha256: `0x${check.manifestSha256}` },
    );
    if (problem !== null) throw new ApprovalRejected(problem);
    state.approvals = [...state.approvals.filter((a) => a.operatorId !== approval.operatorId), approval];
    this.#o.state.save();
    this.#tryResume(approval.app);
    const after = this.#o.state.get(approval.app);
    return { resumed: !after.paused, approvals: after.paused ? after.approvals.length : 0 };
  }

  /** Atestaciones vigentes por app (las vencidas no se entregan: el signer falla cerrado). */
  attestations(): Partial<Record<App, string>> {
    const now = this.#now();
    return Object.fromEntries(
      APPS.flatMap((app) => {
        const entry = this.#tokens.get(app);
        return entry !== undefined && entry.attestation.expiresAt > now ? [[app, entry.token]] : [];
      }),
    );
  }

  status(app: App) {
    const s = this.#o.state.get(app);
    return {
      app,
      status: s.status,
      paused: s.paused,
      pausedAt: s.pausedAt,
      pauseProblems: s.pauseProblems,
      releaseId: s.lastCheck?.releaseId ?? null,
      lastCheckStatus: s.lastCheck?.status ?? null,
      lastCheckProblems: s.lastCheck?.problems.slice(0, 20) ?? [],
      lastCheckAt: s.lastCheckAt,
      lastOkAt: s.lastOkAt,
      approvals: s.approvals.map((a) => a.operatorId),
      resumedAt: s.resumedAt,
      resumedBy: s.resumedBy,
    };
  }
}
