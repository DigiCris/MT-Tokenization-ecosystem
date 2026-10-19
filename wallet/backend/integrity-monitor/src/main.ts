// Entrypoint del integrity monitor (P20):
//   node src/main.ts serve        contenedor propio: ciclo cada MONITOR_INTERVAL_SECONDS + API interna (server.ts)
//   node src/main.ts check-once   chequeo off-host (P20.T02.a): una pasada contra MONITOR_TARGETS con las públicas de
//                                 release del repositorio, reporte JSON por stdout, alerta (notify.ts) y salida 1 si
//                                 alguna app no está OK. No necesita la clave de atestación ni estado.
import { pino } from 'pino';
import { checkRelease } from './check.ts';
import { ConfigError, loadConfig, parseTargets, publicKeysFrom } from './config.ts';
import { IntegrityMonitor } from './monitor.ts';
import { alertChannels, alertText, sendAlert } from './notify.ts';
import { buildServer, createMetrics } from './server.ts';
import { StateStore } from './state.ts';

const logger = pino({ name: 'integrity-monitor', base: null });

async function serve(): Promise<void> {
  const config = loadConfig();
  const metrics = createMetrics();
  const monitor = new IntegrityMonitor({
    platformId: config.platformId,
    manifestEnvironment: config.manifestEnvironment,
    attestationEnvironment: config.appEnv,
    targets: config.targets,
    releaseKeys: config.releaseKeys,
    attestationKey: config.attestationKey,
    operatorKeys: config.operatorKeys,
    attestationTtlSeconds: config.attestationTtlSeconds,
    fetchTimeoutMs: config.fetchTimeoutMs,
    state: new StateStore(config.stateFile),
    events: {
      checked: (app, result, attested) => {
        const state = monitor.status(app);
        metrics.observe(app, result.status, attested.status, state.paused);
        const log = { app, check: result.status, attested: attested.status, releaseId: result.releaseId };
        if (result.status === 'OK') logger.info(log, 'chequeo de integridad');
        else logger.warn({ ...log, problems: result.problems.slice(0, 10) }, 'chequeo de integridad con problemas');
      },
      paused: (app, problems) => {
        logger.error({ app, problems: problems.slice(0, 10) }, 'MISMATCH: cooperación de S pausada');
      },
      resumed: (app, operators) => {
        logger.warn({ app, operators }, 'cooperación reanudada con doble aprobación');
      },
    },
  });
  const server = buildServer(monitor, metrics);
  await server.listen({ host: config.host, port: config.port });
  logger.info({ host: config.host, port: config.port, apps: config.targets.map((t) => t.app) }, 'monitor arriba');
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      await monitor.runCycle();
    } catch (error) {
      logger.error({ err: error }, 'ciclo de integridad fallido');
    } finally {
      running = false;
    }
  };
  await cycle();
  const timer = setInterval(() => void cycle(), config.intervalSeconds * 1000);
  const stop = () => {
    clearInterval(timer);
    void server.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

async function checkOnce(): Promise<number> {
  const env = process.env;
  const appEnv = env.APP_ENV === 'local' || env.APP_ENV === 'staging' ? env.APP_ENV : 'production';
  const targets = parseTargets(env.MONITOR_TARGETS ?? '', appEnv);
  const results = await Promise.all(
    targets.map((target) => {
      const name = `${target.app}_RELEASE_PUBLIC_KEY`;
      const key = env[name] ?? '';
      if (key === '') throw new ConfigError(`falta ${name}`);
      return checkRelease(target, {
        releaseKeys: publicKeysFrom(key, name),
        environment: env.MONITOR_MANIFEST_ENVIRONMENT || appEnv,
        timeoutMs: Number(env.MONITOR_FETCH_TIMEOUT_MS ?? 20_000),
      });
    }),
  );
  process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  if (results.every((r) => r.status === 'OK')) return 0;
  const sent = await sendAlert(alertChannels(), alertText(results, env.ALERT_SOURCE ?? 'chequeo off-host'));
  process.stderr.write(`integridad: alerta enviada por ${sent.length > 0 ? sent.join(' y ') : 'ningún canal'}\n`);
  return 1;
}

if (import.meta.main) {
  const command = process.argv[2];
  try {
    if (command === 'serve') await serve();
    else if (command === 'check-once') process.exitCode = await checkOnce();
    else {
      process.stderr.write('uso: node src/main.ts serve | check-once\n');
      process.exitCode = 2;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`configuración: ${error.message}\n`);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}
