// PF-01…PF-08, PF-23, PF-24: sistema, toolchain fijada, Docker, imágenes, recursos y repositorio.
import { existsSync, statfsSync, readFileSync } from 'node:fs';
import { totalmem, homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { run, runAsync, which, versionGte } from '../lib/proc.mjs';
import { pass, fixed, warn, fail, skip } from '../lib/report.mjs';

const TOOLCHAIN_ANCHOR = 'toolchain-local-del-proyecto';

async function bootstrap(ctx, tool) {
  ctx.log(`  auto-remediación: scripts/tools/bootstrap ${tool}`);
  const r = await runAsync('bash', [join(ctx.root, 'scripts/tools/bootstrap'), tool], { timeoutMs: 1800000 });
  return r.code === 0;
}

function toolVersion(cmd, args, re) {
  const r = run(cmd, args);
  if (r.code !== 0) return null;
  const m = (r.stdout + r.stderr).match(re);
  return m ? m[1] : null;
}

/** Verifica una herramienta fijada; si difiere y fix está activo, ejecuta el bootstrap y re-verifica. */
async function pinnedTool(ctx, { tool, want, probe, label }) {
  let have = probe();
  if (have === want) return pass(`${label} ${want}`);
  if (!ctx.fix) return fail(`${label}: se encontró ${have ?? 'ninguno'}, se exige ${want}`, { what: `${label} ${want}`, how: `bash scripts/tools/bootstrap ${tool}`, anchor: TOOLCHAIN_ANCHOR });
  if (!(await bootstrap(ctx, tool))) return fail(`${label}: el bootstrap falló`, { what: `${label} ${want}`, how: `bash scripts/tools/bootstrap ${tool} (ver el error)`, anchor: TOOLCHAIN_ANCHOR });
  have = probe();
  return have === want ? fixed(`${label} ${want} instalado en .tools`) : fail(`${label}: tras el bootstrap hay ${have ?? 'nada'}`, { what: `${label} ${want}`, how: `bash scripts/tools/bootstrap ${tool}`, anchor: TOOLCHAIN_ANCHOR });
}

export const systemChecks = [
  {
    id: 'PF-01',
    title: 'Herramientas del sistema (bash, git, curl, openssl, tar, xz, python3)',
    run: async (ctx) => {
      const min = ctx.versions.minimums;
      const problems = [];
      const bashV = run('bash', ['-c', 'echo ${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}']).stdout.trim();
      if (!versionGte(bashV, min.bash)) problems.push(`bash ${bashV || '?'} < ${min.bash}`);
      const gitV = toolVersion('git', ['--version'], /git version (\d+\.\d+(?:\.\d+)?)/);
      if (!gitV || !versionGte(gitV, min.git)) problems.push(`git ${gitV ?? 'ausente'} < ${min.git}`);
      for (const c of ['curl', 'openssl', 'tar', 'xz']) if (!which(c)) problems.push(`${c} ausente`);
      if (problems.length) return fail(problems.join('; '), { what: problems.join('; '), how: 'instalar con el gestor de paquetes del sistema (requiere privilegios)', anchor: 'herramientas-del-sistema-sólo-si-faltan' });
      const pyV = toolVersion('python3', ['--version'], /Python (\d+\.\d+(?:\.\d+)?)/);
      if (!pyV || !versionGte(pyV, min.python)) return warn(`python3 ${pyV ?? 'ausente'} < ${min.python}: Slither corre por imagen Docker`);
      return pass(`bash ${bashV}, git ${gitV}, python3 ${pyV}`);
    },
  },
  {
    id: 'PF-02',
    title: 'Node == .node-version',
    run: async (ctx) => {
      const want = readFileSync(join(ctx.root, '.node-version'), 'utf8').trim();
      const have = process.version.replace(/^v/, '');
      if (have !== want) return fail(`Node ${have} en uso, se exige ${want}`, { what: `Node ${want}`, how: 'bash scripts/tools/bootstrap node && source scripts/env.sh', anchor: TOOLCHAIN_ANCHOR });
      return process.env.PREFLIGHT_FIXED_NODE === '1' ? fixed(`Node ${want} instalado en .tools`) : pass(`Node ${want}`);
    },
  },
  {
    id: 'PF-03',
    title: 'pnpm == packageManager',
    run: async (ctx) => {
      const pm = JSON.parse(readFileSync(join(ctx.root, 'package.json'), 'utf8')).packageManager ?? '';
      const want = pm.replace(/^pnpm@/, '');
      return pinnedTool(ctx, { tool: 'pnpm', want, label: 'pnpm', probe: () => toolVersion('pnpm', ['-v'], /^(\d+\.\d+\.\d+)/m) });
    },
  },
  {
    id: 'PF-04',
    title: 'Foundry (forge, cast, anvil) == versión fijada',
    run: async (ctx) => {
      const want = ctx.versions.foundry.semver;
      const probe = () => {
        const vs = ['forge', 'cast', 'anvil'].map((b) => toolVersion(b, ['--version'], new RegExp(`${b} Version: (\\d+\\.\\d+\\.\\d+)`)));
        return vs.every((v) => v === vs[0]) ? vs[0] : `forge ${vs[0]}/cast ${vs[1]}/anvil ${vs[2]}`;
      };
      return pinnedTool(ctx, { tool: 'foundry', want, label: 'Foundry', probe });
    },
  },
  {
    id: 'PF-05',
    title: 'Docker Engine activo + Compose v2',
    run: async (ctx) => {
      if (!which('docker')) return fail('Docker no está instalado', { what: 'Docker Engine con Compose v2', how: 'instalar Docker (guía oficial; requiere privilegios)', anchor: 'docker-sólo-si-falta' });
      const composeV = toolVersion('docker', ['compose', 'version', '--short'], /v?(\d+\.\d+\.\d+)/);
      if (!composeV || !versionGte(composeV, '2.0.0')) return fail(`Docker Compose v2 ausente (${composeV ?? 'no encontrado'})`, { what: 'Docker Compose v2', how: 'instalar el plugin oficial docker compose', anchor: 'docker-sólo-si-falta' });
      const up = () => run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20000 });
      let info = up();
      if (info.code === 0) return pass(`Docker ${info.stdout.trim()}, Compose ${composeV}`);
      if (!ctx.fix) return fail('el daemon de Docker está detenido', { what: 'daemon de Docker activo', how: 'iniciar Docker (rootless: dockerd-rootless.sh; systemd: systemctl --user start docker)', anchor: 'docker-sólo-si-falta' });
      const rootless = which('dockerd-rootless.sh') ?? (existsSync(join(homedir(), 'bin/dockerd-rootless.sh')) ? join(homedir(), 'bin/dockerd-rootless.sh') : null);
      if (rootless) {
        ctx.log('  auto-remediación: iniciando dockerd en modo rootless (sin sudo)');
        const env = { ...process.env, PATH: `${join(homedir(), 'bin')}:${process.env.PATH}` };
        const child = spawn('setsid', [rootless], { detached: true, stdio: 'ignore', env });
        child.unref();
      } else if (which('systemctl') && run('systemctl', ['--user', 'start', 'docker']).code === 0) {
        ctx.log('  auto-remediación: systemctl --user start docker');
      } else {
        return fail('el daemon de Docker está detenido y no se puede iniciar sin privilegios', { what: 'daemon de Docker activo', how: 'iniciar el servicio de Docker (requiere privilegios)', anchor: 'docker-sólo-si-falta' });
      }
      for (let i = 0; i < 60 && info.code !== 0; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        info = up();
      }
      return info.code === 0 ? fixed(`Docker ${info.stdout.trim()} iniciado`) : fail('no se pudo iniciar el daemon de Docker', { what: 'daemon de Docker activo', how: 'revisar el log del daemon e iniciarlo', anchor: 'docker-sólo-si-falta' });
    },
  },
  {
    id: 'PF-06',
    title: 'Slither == versión fijada',
    run: async (ctx) => pinnedTool(ctx, { tool: 'slither', want: ctx.versions.slither.version, label: 'Slither', probe: () => toolVersion('slither', ['--version'], /^(\d+\.\d+\.\d+)/m) }),
  },
  {
    id: 'PF-07',
    title: 'gitleaks == versión fijada',
    run: async (ctx) => pinnedTool(ctx, { tool: 'gitleaks', want: ctx.versions.gitleaks.version, label: 'gitleaks', probe: () => toolVersion('gitleaks', ['version'], /v?(\d+\.\d+\.\d+)/) }),
  },
  {
    id: 'PF-08',
    title: 'Imágenes de seguridad presentes por digest',
    run: async (ctx) => {
      const refs = Object.entries(ctx.versions.securityImages);
      const missing = refs.filter(([, ref]) => run('docker', ['image', 'inspect', ref], { timeoutMs: 20000 }).code !== 0);
      if (!missing.length) return pass(`${refs.length} imágenes`);
      if (!ctx.fix) return fail(`faltan ${missing.map(([n]) => n).join(', ')}`, { what: 'imágenes de seguridad fijadas', how: 'docker pull <imagen@digest> (ver scripts/tools/versions.json)', anchor: TOOLCHAIN_ANCHOR });
      for (const [name, ref] of missing) {
        ctx.log(`  auto-remediación: docker pull ${name} (por digest)`);
        const r = await runAsync('docker', ['pull', '-q', ref], { timeoutMs: 3600000 });
        if (r.code !== 0) return fail(`no se pudo descargar ${name}`, { what: `imagen ${name}`, how: `docker pull ${ref}`, anchor: TOOLCHAIN_ANCHOR });
      }
      return fixed(`descargadas: ${missing.map(([n]) => n).join(', ')}`);
    },
  },
  {
    id: 'PF-23',
    title: 'Recursos: disco ≥ 15 GB y RAM ≥ 8 GB',
    envs: ['local'],
    run: async (ctx) => {
      const fs = statfsSync(ctx.root);
      const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3;
      const ramGb = totalmem() / 1024 ** 3;
      const notes = [];
      if (freeGb < 15) notes.push(`disco libre ${freeGb.toFixed(1)} GB < 15 GB`);
      if (ramGb < 8) notes.push(`RAM ${ramGb.toFixed(1)} GB < 8 GB`);
      return notes.length ? warn(notes.join('; ')) : pass(`disco libre ${freeGb.toFixed(0)} GB, RAM ${ramGb.toFixed(0)} GB`);
    },
  },
  {
    id: 'PF-24',
    title: 'Branch de trabajo y gitleaks sobre el índice',
    envs: ['local'],
    run: async (ctx) => {
      const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.repoRoot }).stdout.trim();
      if (branch !== 'feat/walletWeb/cmarchese') return fail(`branch actual: ${branch}`, { what: 'trabajar en feat/walletWeb/cmarchese (R-01)', how: 'git checkout feat/walletWeb/cmarchese', anchor: 'reglas' });
      if (!which('gitleaks')) return skip('gitleaks no disponible todavía (PF-07)');
      // Con wallet/.gitleaks.toml (P01.T09) se usan las mismas reglas que el hook pre-commit y la CI.
      const config = join(ctx.root, '.gitleaks.toml');
      const args = ['git', '--staged', '--redact', '--no-banner', '--exit-code', '1', ...(existsSync(config) ? ['--config', config] : []), '.'];
      const r = run('gitleaks', args, { cwd: ctx.repoRoot, timeoutMs: 120000 });
      if (r.code !== 0) return fail('gitleaks encontró posibles secretos en cambios staged', { what: 'índice sin secretos', how: 'gitleaks git --staged --redact y quitar los secretos del staging', anchor: 'reglas' });
      return pass(`branch ${branch}, índice sin hallazgos`);
    },
  },
];
