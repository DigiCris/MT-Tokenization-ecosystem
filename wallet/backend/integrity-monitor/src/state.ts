// Estado del monitor por app (P20.T02–T04): el último chequeo, la pausa por MISMATCH (pegajosa: un chequeo OK no la
// levanta) y las aprobaciones de reanudación acumuladas. La pausa y las aprobaciones se persisten en un archivo propio
// (volumen del contenedor, escritura atómica 0600): reiniciar el monitor no reanuda la cooperación.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { ResumeApprovalSchema, type ResumeApproval } from './approvals.ts';
import { APPS, type App, type CheckResult, type Status } from './check.ts';

export interface AppState {
  /** Estado que se atesta: MISMATCH mientras haya pausa, aunque el chequeo vuelva a dar OK. */
  status: Status;
  paused: boolean;
  pausedAt: number | null;
  pauseProblems: string[];
  lastCheck: CheckResult | null;
  lastCheckAt: number | null;
  lastOkAt: number | null;
  approvals: ResumeApproval[];
  resumedAt: number | null;
  resumedBy: string[];
}

const PersistedSchema = z.object({
  version: z.literal(1),
  apps: z.record(
    z.enum(['WALLET', 'RECOVERY']),
    z.object({
      paused: z.boolean(),
      pausedAt: z.number().nullable(),
      pauseProblems: z.array(z.string()),
      approvals: z.array(ResumeApprovalSchema),
      resumedAt: z.number().nullable(),
      resumedBy: z.array(z.string()),
    }),
  ),
});

function emptyState(): AppState {
  return {
    status: 'UNREACHABLE',
    paused: false,
    pausedAt: null,
    pauseProblems: [],
    lastCheck: null,
    lastCheckAt: null,
    lastOkAt: null,
    approvals: [],
    resumedAt: null,
    resumedBy: [],
  };
}

export class StateStore {
  readonly #file: string;
  readonly #apps = new Map<App, AppState>(APPS.map((app) => [app, emptyState()]));

  constructor(file: string) {
    this.#file = file;
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    // Un archivo ilegible no se descarta en silencio (podría borrar una pausa): el monitor no arranca.
    const persisted = PersistedSchema.parse(JSON.parse(raw));
    for (const [app, saved] of Object.entries(persisted.apps) as [
      App,
      z.infer<typeof PersistedSchema>['apps'][App],
    ][]) {
      Object.assign(this.get(app), saved);
      if (saved.paused) this.get(app).status = 'MISMATCH';
    }
  }

  get(app: App): AppState {
    const state = this.#apps.get(app);
    if (state === undefined) throw new Error(`app desconocida ${app}`);
    return state;
  }

  save(): void {
    const apps = Object.fromEntries(
      [...this.#apps].map(([app, s]) => [
        app,
        {
          paused: s.paused,
          pausedAt: s.pausedAt,
          pauseProblems: s.pauseProblems,
          approvals: s.approvals,
          resumedAt: s.resumedAt,
          resumedBy: s.resumedBy,
        },
      ]),
    );
    const temporary = `${this.#file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, apps })}\n`, { mode: 0o600 });
    renameSync(temporary, this.#file);
  }
}
