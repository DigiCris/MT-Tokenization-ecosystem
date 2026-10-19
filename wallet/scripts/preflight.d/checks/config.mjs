// PF-09…PF-12 y PF-25…PF-29: puertos, .env, variables, secretos locales, lockfiles, Playwright,
// estado del signer, mTLS y OPAQUE. Nunca imprime valores: sólo nombres y huellas truncadas.
import { existsSync, statSync, accessSync, constants, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHmac } from 'node:crypto';
import { run, runAsync, which } from '../lib/proc.mjs';
import { isPortListening } from '../lib/net.mjs';
import { isChecksumAddress } from '../lib/keccak.mjs';
import { pgQuery } from '../lib/pg.mjs';
import { pass, fixed, warn, fail, skip } from '../lib/report.mjs';
import { soldeerProblems } from '../lib/soldeer.mjs';

// ---------------------------------------------------------------------------------------------
// Validadores de formato
const v = {
  nonEmpty: (x) => x.length > 0,
  url: (x) => {
    try {
      return ['http:', 'https:'].includes(new URL(x).protocol);
    } catch {
      return false;
    }
  },
  httpsUrl: (x) => {
    try {
      return new URL(x).protocol === 'https:';
    } catch {
      return false;
    }
  },
  int: (x) => /^\d+$/.test(x),
  port: (x) => /^\d+$/.test(x) && Number(x) > 0 && Number(x) < 65536,
  bool: (x) => x === 'true' || x === 'false',
  hex32: (x) => /^[0-9a-f]{32}$/.test(x),
  googleClientId: (x) => /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(x),
  googleSecret: (x) => /^(GOCSPX-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{24})$/.test(x),
  refreshToken: (x) => /^1\/\/[A-Za-z0-9_-]{20,}$/.test(x),
  email: (x) => /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(x),
  domain: (x) => /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(x),
  mailgunKey: (x) => /^(key-[0-9a-f]{32}|[0-9a-f]{32}-[0-9a-f]{8}-[0-9a-f]{8})$/.test(x),
  mailgunBase: (x) => /^https:\/\/api(\.eu)?\.mailgun\.net$/.test(x),
  etherscanKey: (x) => /^[A-Z0-9]{34}$/.test(x),
  address: (x) => isChecksumAddress(x),
  addressList: (x) => x.split(',').map((s) => s.trim()).filter(Boolean).every(isChecksumAddress),
  jsonShards: (x) => {
    try {
      const a = JSON.parse(x);
      return Array.isArray(a) && a.length > 0 && a.every((s) => typeof s.id === 'string' && /^https:\/\//.test(s.url));
    } catch {
      return false;
    }
  },
  b64len: (n) => (x) => /^[A-Za-z0-9+/]+={0,2}$/.test(x) && Buffer.from(x, 'base64').length === n,
  hexBytes: (n) => (x) => new RegExp(`^(0x)?[0-9a-f]{${n * 2}}$`).test(x),
  enumOf: (...vals) => (x) => vals.includes(x),
};

const CRED = {
  base: 'base_rpc_url',
  secondary: 'base_rpc_url_secondary',
  wc: 'walletconnect_project_id',
  gW: 'google_client_id_wallet',
  gR: 'google_client_id_recovery',
  mail: 'email_provider_api_key--email_from',
  eth: 'etherscan_api_key',
  drive: 'google_drive_test_client_id--google_drive_test_client_secret--google_drive_test_refresh_token',
  gmail: 'email_test_address--email_test_google_refresh_token',
  cfg: 'variables-de-configuración-local',
  gov: 'governance_safe_address--policy_guardians',
  dom: 'wallet_domain--recovery_domain',
  alert: 'alert_email--alert_webhook_url',
};

// Cómo obtener cada grupo de variables (el detalle paso a paso está en la sección de SETUP del ancla).
const HOW_BY_ANCHOR = {
  [CRED.base]: 'crear una app de Alchemy en la red Base Mainnet y copiar su URL HTTPS',
  [CRED.secondary]: 'crear un endpoint de QuickNode en Base Mainnet y copiar su URL HTTPS',
  [CRED.wc]: 'copiar el Project ID del proyecto en dashboard.reown.com',
  [CRED.gW]: 'Google Cloud Console → proyecto de Wallet → Credenciales → ID de cliente OAuth (aplicación web)',
  [CRED.gR]: 'Google Cloud Console → proyecto de Recovery → Credenciales → ID de cliente OAuth (aplicación web)',
  [CRED.mail]: 'Mailgun → Sending → Domains (dominio y región) y API Security (API key)',
  [CRED.eth]: 'etherscan.io → API Dashboard → crear una API key (la API V2 la acepta para Base)',
  [CRED.drive]: 'cliente OAuth "drive-tests" y refresh token con scope drive.appdata de la cuenta de prueba',
  [CRED.gmail]: 'cliente OAuth "drive-tests" y refresh token con scope gmail.readonly de EMAIL_TEST_ADDRESS',
  [CRED.cfg]: 'copiar el valor por defecto de wallet/.env.example',
  [CRED.gov]: 'direcciones de la Governance Safe y de los guardianes del entorno (ceremonia de P25)',
  [CRED.dom]: 'dominios de Wallet y Recovery del entorno',
  [CRED.alert]: 'email y webhook de alertas del entorno',
};

// [variable, validador, ancla, descripción del formato, entornos ('*' = todos), opcional]
const VARS = [
  ['APP_ENV', v.enumOf('local', 'staging', 'production'), CRED.cfg, 'local | staging | production', '*'],
  ['CHAIN_ID', (x) => x === '8453', CRED.cfg, '8453', '*'],
  ['BASE_RPC_URL', v.httpsUrl, CRED.base, 'URL https de Alchemy (Base Mainnet)', '*'],
  ['BASE_RPC_URL_SECONDARY', v.httpsUrl, CRED.secondary, 'URL https de QuickNode (Base Mainnet)', 'staging,production'],
  ['FORK_BLOCK_NUMBER', v.int, CRED.cfg, 'número de bloque', 'local'],
  ['LOCAL_RPC_URL', v.url, CRED.cfg, 'URL http del fork', 'local'],
  ['ANVIL_HOST_PORT', v.port, CRED.cfg, 'puerto', 'local'],
  ['POSTGRES_HOST_PORT', v.port, CRED.cfg, 'puerto', 'local'],
  ['POSTGRES_USER', v.nonEmpty, CRED.cfg, 'usuario admin de Postgres', 'local'],
  ['POSTGRES_DB', v.nonEmpty, CRED.cfg, 'nombre de DB', 'local'],
  ['REDIS_HOST_PORT', v.port, CRED.cfg, 'puerto', 'local'],
  ['MAILPIT_SMTP_PORT', v.port, CRED.cfg, 'puerto', 'local'],
  ['MAILPIT_UI_PORT', v.port, CRED.cfg, 'puerto', 'local'],
  ['API_WALLET_PORT', v.port, CRED.cfg, 'puerto', '*'],
  ['API_RECOVERY_PORT', v.port, CRED.cfg, 'puerto', '*'],
  ['API_PUBLIC_URL_WALLET', v.url, CRED.cfg, 'URL', '*'],
  ['API_PUBLIC_URL_RECOVERY', v.url, CRED.cfg, 'URL', '*'],
  ['WALLET_ORIGIN', v.url, CRED.cfg, 'origin http(s)', '*'],
  ['RECOVERY_ORIGIN', v.url, CRED.cfg, 'origin http(s)', '*'],
  ['METRICS_PORT', v.port, CRED.cfg, 'puerto', '*'],
  ['RPC_PRIMARY_URL', v.url, CRED.cfg, 'URL RPC', '*'],
  ['RPC_SECONDARY_URL', v.url, CRED.cfg, 'URL RPC', '*'],
  ['RPC_QUORUM_MODE', v.enumOf('local-single', 'dual'), CRED.cfg, 'local-single | dual', '*'],
  ['CONFIRMATION_POLICY', v.enumOf('depth', 'tags'), CRED.cfg, 'depth | tags', '*'],
  ['CONFIRMATION_DEPTH', v.int, CRED.cfg, 'entero', '*'],
  ['FINALIZATION_DEPTH', v.int, CRED.cfg, 'entero', '*'],
  ['EMAIL_PROVIDER', v.enumOf('smtp', 'mailgun'), CRED.mail, 'smtp | mailgun', '*'],
  ['EMAIL_FROM', v.email, CRED.mail, 'dirección de email', '*'],
  ['EMAIL_PROVIDER_API_KEY', v.mailgunKey, CRED.mail, 'API key de Mailgun', '*'],
  ['EMAIL_PROVIDER_DOMAIN', v.domain, CRED.mail, 'dominio de Mailgun', '*'],
  ['EMAIL_PROVIDER_BASE_URL', v.mailgunBase, CRED.mail, 'https://api.mailgun.net o https://api.eu.mailgun.net', '*'],
  ['SMTP_HOST', v.nonEmpty, CRED.cfg, 'host SMTP (local: Mailpit)', 'local'],
  ['SMTP_PORT', v.port, CRED.cfg, 'puerto', 'local'],
  ['SIGNER_PROVIDER', (x) => x === 'development', CRED.cfg, 'development (local)', 'local'],
  ['SIGNER_PROVIDER', (x) => x === 'selfhosted', CRED.cfg, 'selfhosted', 'staging,production'],
  ['SIGNER_SHARD_ID', v.nonEmpty, CRED.cfg, 'id de shard', '*'],
  ['SIGNER_PORT', v.port, CRED.cfg, 'puerto', '*'],
  ['SIGNER_SHARDS', v.jsonShards, CRED.cfg, 'JSON [{"id","url":"https://…"}]', '*'],
  ['SIGNER_KEYSTORE_DIR', v.nonEmpty, CRED.cfg, 'ruta', '*'],
  ['SIGNER_UNLOCK_CREDENTIAL_FILE', v.nonEmpty, CRED.cfg, 'ruta', '*'],
  ['SIGNER_RPC_PRIMARY_URL', v.url, CRED.cfg, 'URL RPC', '*'],
  ['SIGNER_RPC_SECONDARY_URL', v.url, CRED.cfg, 'URL RPC', '*'],
  ['MTLS_CA_CERT_PATH', v.nonEmpty, CRED.cfg, 'ruta', '*'],
  ['MTLS_BACKEND_CLIENT_CERT_PATH', v.nonEmpty, CRED.cfg, 'ruta', '*'],
  ['MTLS_BACKEND_CLIENT_KEY_PATH', v.nonEmpty, CRED.cfg, 'ruta', '*'],
  ['MTLS_SIGNER_SERVER_CERT_PATH', v.nonEmpty, CRED.cfg, 'ruta', '*'],
  ['MTLS_SIGNER_SERVER_KEY_PATH', v.nonEmpty, CRED.cfg, 'ruta', '*'],
  ['POLICY_SNAPSHOT_PATH', v.nonEmpty, CRED.cfg, 'ruta', '*'],
  ['INTEGRITY_REQUIRED', v.bool, CRED.cfg, 'true | false', '*'],
  ['GAS_TOPUP_MIN_WEI', v.int, CRED.cfg, 'wei', '*'],
  ['GAS_TOPUP_TARGET_WEI', v.int, CRED.cfg, 'wei', '*'],
  ['GAS_TANK_DAILY_CAP_WEI', v.int, CRED.cfg, 'wei', '*'],
  ['DEPLOYER_KEY_SOURCE', v.enumOf('local-seed', 'keystore', 'ledger', 'trezor'), CRED.cfg, 'local-seed | keystore | ledger | trezor', '*'],
  ['WALLET_API_BASE_URL', v.url, CRED.cfg, 'URL', '*'],
  ['WALLET_FRONTEND_RPC_URL', v.url, CRED.cfg, 'URL RPC', '*'],
  ['GOOGLE_CLIENT_ID_WALLET', v.googleClientId, CRED.gW, '<número>-<id>.apps.googleusercontent.com', '*'],
  ['GOOGLE_OAUTH_REDIRECT_URI_WALLET', v.url, CRED.gW, 'URL de callback', '*'],
  ['RECOVERY_API_BASE_URL', v.url, CRED.cfg, 'URL', '*'],
  ['RECOVERY_FRONTEND_RPC_URL', v.url, CRED.cfg, 'URL RPC', '*'],
  ['GOOGLE_CLIENT_ID_RECOVERY', v.googleClientId, CRED.gR, '<número>-<id>.apps.googleusercontent.com', '*'],
  ['GOOGLE_OAUTH_REDIRECT_URI_RECOVERY', v.url, CRED.gR, 'URL de callback', '*'],
  ['WALLETCONNECT_PROJECT_ID', v.hex32, CRED.wc, '32 caracteres hex', '*'],
  ['ETHERSCAN_API_KEY', v.etherscanKey, CRED.eth, '34 caracteres alfanuméricos', 'staging,production'],
  ['GOVERNANCE_SAFE_ADDRESS', v.address, CRED.gov, 'dirección EIP-55', 'staging,production'],
  ['POLICY_GUARDIANS', v.addressList, CRED.gov, 'direcciones EIP-55 separadas por coma', 'staging,production'],
  ['ALERT_EMAIL', v.email, CRED.alert, 'dirección de email', 'staging,production'],
  ['WALLET_DOMAIN', v.domain, CRED.dom, 'dominio', 'staging,production'],
  ['RECOVERY_DOMAIN', v.domain, CRED.dom, 'dominio', 'staging,production'],
  ['GOOGLE_DRIVE_TEST_CLIENT_ID', v.googleClientId, CRED.drive, '<número>-<id>.apps.googleusercontent.com', 'local'],
  ['GOOGLE_DRIVE_TEST_CLIENT_SECRET', v.googleSecret, CRED.drive, 'client secret de Google (GOCSPX-…)', 'local'],
  ['GOOGLE_DRIVE_TEST_REFRESH_TOKEN', v.refreshToken, CRED.drive, 'refresh token de Google (1//…)', 'local'],
  ['EMAIL_TEST_ADDRESS', v.email, CRED.gmail, 'dirección de Gmail de prueba', 'local'],
  ['EMAIL_TEST_GOOGLE_CLIENT_ID', v.googleClientId, CRED.gmail, '<número>-<id>.apps.googleusercontent.com', 'local'],
  ['EMAIL_TEST_GOOGLE_CLIENT_SECRET', v.googleSecret, CRED.gmail, 'client secret de Google (GOCSPX-…)', 'local'],
  ['EMAIL_TEST_GOOGLE_REFRESH_TOKEN', v.refreshToken, CRED.gmail, 'refresh token de Google (1//…)', 'local'],
];
// Opcionales: si están definidas, deben tener formato válido.
const OPTIONAL = [
  ['BASE_RPC_URL_SECONDARY', v.httpsUrl, CRED.secondary, 'URL https de QuickNode (Base Mainnet)', 'local'],
  ['ETHERSCAN_API_KEY', v.etherscanKey, CRED.eth, '34 caracteres alfanuméricos', 'local'],
  ['ALERT_WEBHOOK_URL', v.httpsUrl, CRED.alert, 'URL https', '*'],
];

// Secretos que genera `secrets-local` (sólo local).
export const LOCAL_SECRETS = [
  ['POSTGRES_PASSWORD', v.hexBytes(24)],
  ['MTW_APP_DB_PASSWORD', v.hexBytes(24)],
  ['MTW_MIGRATOR_DB_PASSWORD', v.hexBytes(24)],
  ['MTW_SIGNER_DB_PASSWORD', v.hexBytes(24)],
  ['DATABASE_URL', (x) => /^postgres:\/\/mtw_app:/.test(x)],
  ['DATABASE_MIGRATION_URL', (x) => /^postgres:\/\/mtw_migrator:/.test(x)],
  ['SIGNER_DATABASE_URL', (x) => /^postgres:\/\/mtw_signer:/.test(x)],
  ['REDIS_PASSWORD', v.hexBytes(24)],
  ['REDIS_URL', (x) => /^redis:\/\/:/.test(x)],
  ['LOCAL_SEED', v.hexBytes(32)],
  ['GRAFANA_ADMIN_PASSWORD', v.hexBytes(16)],
  ['SESSION_SECRET', v.b64len(32)],
  ['CSRF_SECRET', v.b64len(32)],
  ['SESSION_ISSUER_PRIVATE_KEY', v.b64len(48)],
  ['SESSION_ISSUER_PUBLIC_KEY', v.b64len(44)],
  ['APP_FIELD_ENCRYPTION_KEY', v.b64len(32)],
  ['OTP_HMAC_KEY', v.b64len(32)],
  ['PASSWORD_PEPPER_V1', v.b64len(32)],
  ['AUDIT_CHAIN_KEY', v.b64len(32)],
  ['SIGNER_ATTESTATION_PRIVATE_KEY', v.b64len(48)],
  ['SIGNER_ATTESTATION_PUBLIC_KEY', v.b64len(44)],
  ['POLICY_SIGNING_PRIVATE_KEY_LOCAL', v.b64len(48)],
  ['POLICY_SIGNING_PUBLIC_KEY', v.b64len(44)],
  ['INTEGRITY_MONITOR_PRIVATE_KEY', v.b64len(48)],
  ['INTEGRITY_MONITOR_PUBLIC_KEY', v.b64len(44)],
  ['WALLET_RELEASE_SIGNING_KEY_LOCAL', v.b64len(48)],
  ['WALLET_RELEASE_PUBLIC_KEY', v.b64len(44)],
  ['RECOVERY_RELEASE_SIGNING_KEY_LOCAL', v.b64len(48)],
  ['RECOVERY_RELEASE_PUBLIC_KEY', v.b64len(44)],
  ['SOVEREIGN_EXIT_RELEASE_SIGNING_KEY_LOCAL', v.b64len(48)],
  ['SOVEREIGN_EXIT_RELEASE_PUBLIC_KEY', v.b64len(44)],
];

const appliesTo = (envs, name) => envs === '*' || envs.split(',').includes(name);
const absPath = (ctx, p) => (isAbsolute(p) ? p : resolve(ctx.root, p));

/** Valida variables (PF-11). Devuelve lista de problemas {name, anchor, format, missing}. */
export function validateVars(env, envName) {
  const problems = [];
  for (const [name, check, anchor, format, envs] of VARS) {
    if (!appliesTo(envs, envName)) continue;
    const val = env[name];
    if (val === undefined || val === '') problems.push({ name, anchor, format, missing: true });
    else if (!check(val)) problems.push({ name, anchor, format, missing: false });
  }
  for (const [name, check, anchor, format, envs] of OPTIONAL) {
    if (!appliesTo(envs, envName)) continue;
    const val = env[name];
    if (val && !check(val)) problems.push({ name, anchor, format, missing: false });
  }
  return problems;
}

export function missingLocalSecrets(env) {
  return LOCAL_SECRETS.filter(([name, check]) => !env[name] || !check(env[name])).map(([name]) => name);
}

async function runSecretsLocal(ctx, extra = []) {
  ctx.log(`  auto-remediación: scripts/secrets-local ${extra.join(' ')}`.trimEnd());
  const r = await runAsync('bash', [join(ctx.root, 'scripts/secrets-local'), ...extra], { env: { ...process.env, MTW_ENV_FILE: ctx.envFile } });
  if (r.code === 0) ctx.reloadEnv();
  return r.code === 0;
}

// ---------------------------------------------------------------------------------------------
const COMPOSE_PROJECT = 'mtw-local';
// Procesos de Docker que escuchan en nombre de cualquier contenedor: nunca se consideran "propios".
const DOCKER_LISTENERS = new Set(['rootlesskit', 'docker-proxy', 'dockerd', 'containerd', 'slirp4netns', 'vpnkit', 'com.docker.backend']);

const portOf = (url, fallback) => {
  try {
    return Number(new URL(url).port) || fallback;
  } catch {
    return fallback;
  }
};

/** Puertos locales de §5.3 tomados de la configuración (wallet/.env), con los defaults del planner. */
export function localPorts(env) {
  const n = (k, d) => Number(env[k]) || d;
  const metrics = n('METRICS_PORT', 9464);
  return [
    portOf(env.WALLET_ORIGIN, 5173),
    portOf(env.RECOVERY_ORIGIN, 5174),
    n('API_WALLET_PORT', 8080),
    n('API_RECOVERY_PORT', 8081),
    n('SIGNER_PORT', 8090),
    n('ANVIL_HOST_PORT', 8545),
    n('POSTGRES_HOST_PORT', 55432),
    n('REDIS_HOST_PORT', 56379),
    n('MAILPIT_SMTP_PORT', 1025),
    n('MAILPIT_UI_PORT', 8025),
    ...Array.from({ length: 7 }, (_, i) => metrics + i),
  ];
}

/** Mapa puerto publicado → {contenedor, proyecto compose} de los contenedores en ejecución. */
function dockerPublishers() {
  const map = new Map();
  const r = run('docker', ['ps', '--format', '{{json .}}'], { timeoutMs: 20000 });
  if (r.code !== 0) return map;
  for (const line of r.stdout.trim().split('\n').filter(Boolean)) {
    try {
      const c = JSON.parse(line);
      const project = (c.Labels ?? '').match(/(?:^|,)com\.docker\.compose\.project=([^,]+)/)?.[1] ?? '';
      for (const m of String(c.Ports ?? '').matchAll(/:(\d+)->/g)) map.set(Number(m[1]), { name: c.Names, project });
    } catch {
      /* línea no JSON */
    }
  }
  return map;
}

/** PID y nombre del proceso que escucha en el puerto (sólo procesos del usuario), vía `ss -ltnpH`. */
function listener(port) {
  if (!which('ss')) return null;
  const r = run('ss', ['-ltnpH', `sport = :${port}`]);
  const m = r.stdout.match(/\(\("([^"]+)",pid=(\d+)/);
  return m ? { comm: m[1], pid: Number(m[2]) } : null;
}

function pidIsOurs(ctx, l) {
  if (!l || DOCKER_LISTENERS.has(l.comm)) return false;
  try {
    const cwd = realpathSync(`/proc/${l.pid}/cwd`);
    return cwd === ctx.root || cwd.startsWith(ctx.root + '/');
  } catch {
    return false;
  }
}

/** Devuelve [{port, owner}] de los puertos ocupados por algo que no es de wallet/. */
export async function checkPorts(ctx, ports = localPorts(ctx.env)) {
  const publishers = dockerPublishers();
  const busy = [];
  for (const port of ports) {
    if (!(await isPortListening(port))) continue;
    const pub = publishers.get(port);
    if (pub) {
      if (pub.project === COMPOSE_PROJECT) continue;
      busy.push({ port, owner: `contenedor ${pub.name}${pub.project ? ` (proyecto ${pub.project})` : ''}` });
      continue;
    }
    const l = listener(port);
    if (pidIsOurs(ctx, l)) continue;
    busy.push({ port, owner: l ? `proceso ${l.comm} (pid ${l.pid})` : 'proceso de otro usuario' });
  }
  return busy;
}

// ---------------------------------------------------------------------------------------------
export const configChecks = [
  {
    id: 'PF-09',
    title: 'Puertos locales libres (o usados por servicios propios)',
    envs: ['local'],
    run: async (ctx) => {
      const ports = ctx.portsOverride ?? localPorts(ctx.env);
      const busy = await checkPorts(ctx, ports);
      if (busy.length) {
        const list = busy.map((b) => `${b.port} (${b.owner})`).join(', ');
        return fail(`puertos ocupados por otro proceso: ${list}`, { what: `liberar los puertos ${busy.map((b) => b.port).join(', ')}`, variable: 'puertos de §5.3 (*_PORT en wallet/.env)', how: 'detener lo que los usa o cambiar el puerto correspondiente en wallet/.env (y las URLs que lo incluyen)', anchor: 'puertos-locales-ocupados' });
      }
      return pass(`${ports.length} puertos verificados`);
    },
  },
  {
    id: 'PF-10',
    title: 'wallet/.env existe y está ignorado por git',
    run: async (ctx) => {
      if (!existsSync(ctx.envFile)) return fail('no existe wallet/.env', { what: 'archivo wallet/.env', variable: '—', how: 'cp .env.example .env (y completar las credenciales)', anchor: 'reglas' });
      const rel = relative(ctx.repoRoot, ctx.envFile);
      const r = run('git', ['check-ignore', '-q', rel], { cwd: ctx.repoRoot });
      if (r.code !== 0) return fail('wallet/.env NO está ignorado por git', { what: '.env ignorado por git', variable: '—', how: 'agregar ".env" a wallet/.gitignore', anchor: 'reglas' });
      return pass('existe y está ignorado');
    },
  },
  {
    id: 'PF-11',
    title: 'Variables obligatorias presentes y con formato válido',
    run: async (ctx) => {
      const problems = validateVars(ctx.env, ctx.envName);
      if (ctx.envName === 'local' && ctx.env.FORK_BLOCK_NUMBER && ctx.chainConfig && Number(ctx.env.FORK_BLOCK_NUMBER) !== ctx.chainConfig.fork.blockNumber) {
        problems.push({ name: 'FORK_BLOCK_NUMBER', anchor: CRED.cfg, format: `igual a config/chains/base-mainnet.json (${ctx.chainConfig.fork.blockNumber})`, missing: false });
      }
      if (ctx.env.APP_ENV && ctx.env.APP_ENV !== ctx.envName) problems.push({ name: 'APP_ENV', anchor: CRED.cfg, format: `igual a --env (${ctx.envName})`, missing: false });
      if (!problems.length) return pass('todas presentes y válidas');
      const first = problems[0];
      return fail(problems.map((p) => `${p.name} ${p.missing ? 'ausente' : 'con formato inválido'}`).join('; '), {
        what: problems.map((p) => `${p.name} (${p.missing ? 'falta' : 'formato inválido'}; esperado: ${p.format})`).join('; '),
        variable: problems.map((p) => p.name).join(', '),
        how: `${[...new Set(problems.map((p) => HOW_BY_ANCHOR[p.anchor] ?? 'ver la sección indicada'))].join('; ')} — cargarlo en wallet/.env (el preflight nunca muestra los valores)`,
        anchor: first.anchor,
      });
    },
  },
  {
    id: 'PF-12',
    title: 'Secretos locales presentes (o prohibidos en staging/production)',
    run: async (ctx) => {
      if (ctx.envName !== 'local') {
        const forbidden = Object.keys(ctx.env).filter((k) => k === 'LOCAL_SEED' || k.endsWith('_LOCAL'));
        const examples = Object.entries(ctx.env).filter(([k, val]) => /(SECRET|PASSWORD|KEY|TOKEN)/.test(k) && /^(changeme|example|placeholder|dummy|xxx+|<.*>)$/i.test(val)).map(([k]) => k);
        if (forbidden.length || examples.length) return fail(`variables prohibidas fuera de local: ${[...forbidden, ...examples].join(', ')}`, { what: 'sin secretos de ejemplo ni claves *_LOCAL', variable: [...forbidden, ...examples].join(', '), how: 'generar los secretos con scripts/deploy/init-secrets.sh (ADR-030)', anchor: 'auto-generated' });
        return pass('sin valores de ejemplo ni claves locales');
      }
      let missing = missingLocalSecrets(ctx.env);
      if (!missing.length) return pass(`${LOCAL_SECRETS.length} secretos locales presentes`);
      if (!ctx.fix) return fail(`faltan secretos locales: ${missing.join(', ')}`, { what: 'secretos locales generados', variable: missing.join(', '), how: 'pnpm secrets:local', anchor: 'auto-generated' });
      if (!(await runSecretsLocal(ctx))) return fail('secrets-local falló', { what: 'secretos locales generados', variable: missing.join(', '), how: 'pnpm secrets:local (ver el error)', anchor: 'auto-generated' });
      missing = missingLocalSecrets(ctx.env);
      return missing.length ? fail(`siguen faltando: ${missing.join(', ')}`, { what: 'secretos locales', variable: missing.join(', '), how: 'pnpm secrets:local', anchor: 'auto-generated' }) : fixed(`generados con secrets-local (${LOCAL_SECRETS.length})`);
    },
  },
  {
    id: 'PF-25',
    title: 'Lockfiles presentes y consistentes (desde P01)',
    run: async (ctx) => {
      const projects = ['contracts', 'backend/app', 'backend/signer', 'backend/integrity-monitor', 'frontend/wallet', 'frontend/recovery', 'e2e', 'tools/sovereign-exit'].filter((p) => existsSync(join(ctx.root, p, 'package.json')) || existsSync(join(ctx.root, p, 'foundry.toml')));
      if (!projects.length) return skip('todavía no hay proyectos (se crean desde P01)');
      const problems = [];
      for (const p of projects) {
        const dir = join(ctx.root, p);
        if (existsSync(join(dir, 'package.json'))) {
          if (!existsSync(join(dir, 'pnpm-lock.yaml'))) {
            problems.push(`${p}: falta pnpm-lock.yaml`);
            continue;
          }
          const r = run('pnpm', ['install', '--frozen-lockfile', '--lockfile-only', '--ignore-scripts', '--reporter=silent'], { cwd: dir, timeoutMs: 600000 });
          if (r.code !== 0) problems.push(`${p}: pnpm-lock.yaml inconsistente con package.json`);
        } else if (existsSync(join(dir, 'foundry.toml'))) {
          // Soldeer en lugar de submódulos (ADR-032, P03.T02): soldeer.lock con checksums o commit exacto.
          let found = soldeerProblems(dir);
          if (found.some((x) => x.includes('no instalada')) && ctx.fix) {
            run('forge', ['soldeer', 'install'], { cwd: dir, timeoutMs: 900000 });
            found = soldeerProblems(dir);
          }
          for (const x of found) problems.push(`${p}: ${x}`);
        }
      }
      return problems.length ? fail(problems.join('; '), { what: 'lockfiles consistentes', how: 'proyectos pnpm: pnpm install y commitear pnpm-lock.yaml; contracts: forge soldeer install (soldeer.lock commiteado)', anchor: 'toolchain-local-del-proyecto' }) : pass(`${projects.length} proyecto(s): ${projects.join(', ')}`);
    },
  },
  {
    id: 'PF-26',
    title: 'Navegadores de Playwright instalados (desde P22)',
    envs: ['local'],
    run: async (ctx) => {
      const e2e = join(ctx.root, 'e2e');
      if (!existsSync(join(e2e, 'package.json'))) return skip('wallet/e2e todavía no existe (P22)');
      const r = run('pnpm', ['exec', 'playwright', 'install', '--dry-run'], { cwd: e2e, timeoutMs: 120000 });
      const dirs = [...(r.stdout + r.stderr).matchAll(/Install location:\s+(\S+)/g)].map((m) => m[1]);
      const missing = dirs.filter((d) => !existsSync(d));
      if (r.code === 0 && dirs.length && !missing.length) return pass(`${dirs.length} navegadores`);
      if (!ctx.fix) return fail('faltan navegadores de Playwright', { what: 'navegadores de Playwright', how: 'pnpm --dir e2e exec playwright install --with-deps chromium firefox webkit', anchor: 'toolchain-local-del-proyecto' });
      const inst = await runAsync('pnpm', ['exec', 'playwright', 'install', 'chromium', 'firefox', 'webkit'], { cwd: e2e, timeoutMs: 3600000 });
      return inst.code === 0 ? fixed('navegadores instalados') : fail('no se pudieron instalar los navegadores', { what: 'navegadores de Playwright', how: 'pnpm --dir e2e exec playwright install', anchor: 'toolchain-local-del-proyecto' });
    },
  },
  {
    id: 'PF-27',
    title: 'Signer: keystores (0700) y credencial de desbloqueo separada (0600), por shard',
    run: async (ctx) => {
      // Shards locales: dev-1 (S) y, si está configurado, platform (cuenta gas tank). En stg/prod, el del contenedor.
      const shards = [
        { id: ctx.env.SIGNER_SHARD_ID || 'dev-1', ks: ctx.env.SIGNER_KEYSTORE_DIR, cred: ctx.env.SIGNER_UNLOCK_CREDENTIAL_FILE, db: ctx.env.SIGNER_DATABASE_URL },
      ];
      if (ctx.env.SIGNER_PLATFORM_KEYSTORE_DIR || ctx.envName === 'local') {
        shards.push({ id: 'platform', ks: ctx.env.SIGNER_PLATFORM_KEYSTORE_DIR, cred: ctx.env.SIGNER_PLATFORM_UNLOCK_CREDENTIAL_FILE, db: ctx.env.SIGNER_PLATFORM_DATABASE_URL });
      }
      const check = () => {
        const problems = [];
        for (const shard of shards) {
          if (!shard.ks || !shard.cred) {
            problems.push(`${shard.id}: faltan keystores o credencial en .env`);
            continue;
          }
          const ks = absPath(ctx, shard.ks);
          const cred = absPath(ctx, shard.cred);
          try {
            const st = statSync(ks);
            if (!st.isDirectory()) problems.push(`${shard.id}: el directorio de keystores no es un directorio`);
            else if ((st.mode & 0o777) !== 0o700) problems.push(`${shard.id}: el directorio de keystores debe ser 0700`);
            accessSync(ks, constants.W_OK);
          } catch {
            problems.push(`${shard.id}: directorio de keystores ausente o no escribible`);
          }
          try {
            const st = statSync(cred);
            if ((st.mode & 0o077) !== 0) problems.push(`${shard.id}: la credencial de desbloqueo debe ser 0600 o 0400`);
            if (!/^[0-9a-f]{64}$/.test(readFileSync(cred, 'utf8').replace(/\r?\n$/, ''))) problems.push(`${shard.id}: la credencial debe ser 32 bytes en hex`);
          } catch {
            problems.push(`${shard.id}: credencial de desbloqueo ausente`);
          }
          const relCred = relative(ks, cred);
          if (!relCred.startsWith('..') && !isAbsolute(relCred)) problems.push(`${shard.id}: la credencial NO puede estar dentro del directorio de keystores`);
        }
        return problems;
      };
      let problems = check();
      let wasFixed = false;
      if (problems.length && ctx.fix && ctx.envName === 'local') {
        if (await runSecretsLocal(ctx)) {
          problems = check();
          wasFixed = true;
        }
      }
      if (problems.length) return fail(problems.join('; '), { what: 'estado del signer', variable: 'SIGNER_KEYSTORE_DIR, SIGNER_UNLOCK_CREDENTIAL_FILE, SIGNER_PLATFORM_*', how: ctx.envName === 'local' ? 'pnpm secrets:local' : 'ver docs/runbooks/signer-lifecycle.md (alta de un shard)', anchor: 'auto-generated' });
      // Si el shard ya está registrado en su DB, la huella de la credencial montada debe coincidir:
      // credentialFingerprint = HMAC-SHA256(credencial, "mtw-signer-credential-fingerprint-v1") ([B-SIG-08]).
      for (const shard of shards) {
        if (!shard.db) continue;
        try {
          const [[reg]] = await pgQuery(shard.db, "select to_regclass('public.signer_shards')::text");
          if (!reg) continue;
          const rows = await pgQuery(shard.db, `select credential_fingerprint from signer_shards where shard_id = '${String(shard.id).replace(/'/g, "''")}'`);
          const credential = Buffer.from(readFileSync(absPath(ctx, shard.cred), 'utf8').replace(/\r?\n$/, ''), 'hex');
          const fp = `0x${createHmac('sha256', credential).update('mtw-signer-credential-fingerprint-v1').digest('hex')}`;
          if (rows.length && rows[0][0] !== fp) return fail(`${shard.id}: credentialFingerprint distinto al registrado en la DB del signer`, { what: 'credencial de desbloqueo correcta para el shard', variable: 'SIGNER_UNLOCK_CREDENTIAL_FILE', how: 'restaurar la credencial correcta (docs/runbooks/signer-lifecycle.md)', anchor: 'auto-generated' });
        } catch {
          /* la DB puede no estar levantada aún: PF-17/PF-18 lo reportan */
        }
      }
      return wasFixed ? fixed('directorios y credenciales generados') : pass(`keystores 0700 y credencial separada en ${shards.map((x) => x.id).join(', ')}`);
    },
  },
  {
    id: 'PF-28',
    title: 'Certificados mTLS presentes, vigentes y firmados por la CA',
    run: async (ctx) => {
      const paths = ['MTLS_CA_CERT_PATH', 'MTLS_BACKEND_CLIENT_CERT_PATH', 'MTLS_BACKEND_CLIENT_KEY_PATH', 'MTLS_SIGNER_SERVER_CERT_PATH', 'MTLS_SIGNER_SERVER_KEY_PATH'].map((k) => [k, absPath(ctx, ctx.env[k] ?? '')]);
      const check = () => {
        const problems = [];
        for (const [k, p] of paths) if (!existsSync(p)) problems.push(`${k} no existe`);
        if (problems.length) return problems;
        const [, ca] = paths[0];
        for (const [k, p] of [paths[1], paths[3]]) {
          if (run('openssl', ['verify', '-CAfile', ca, p]).code !== 0) problems.push(`${k} no está firmado por la CA`);
          if (run('openssl', ['x509', '-checkend', '86400', '-noout', '-in', p]).code !== 0) problems.push(`${k} vence en menos de 24 h`);
        }
        if (run('openssl', ['x509', '-checkend', '86400', '-noout', '-in', ca]).code !== 0) problems.push('la CA vence en menos de 24 h');
        return problems;
      };
      let problems = check();
      if (!problems.length) return pass('CA, servidor del signer y cliente del backend válidos');
      if (!(ctx.fix && ctx.envName === 'local')) return fail(problems.join('; '), { what: 'certificados mTLS válidos', variable: 'MTLS_*', how: ctx.envName === 'local' ? 'pnpm secrets:local -- --regen-mtls' : 'regenerar con la CA del entorno (runbook)', anchor: 'auto-generated' });
      if (!(await runSecretsLocal(ctx, ['--regen-mtls']))) return fail('no se pudieron regenerar los certificados', { what: 'certificados mTLS', variable: 'MTLS_*', how: 'pnpm secrets:local -- --regen-mtls', anchor: 'auto-generated' });
      problems = check();
      return problems.length ? fail(problems.join('; '), { what: 'certificados mTLS válidos', variable: 'MTLS_*', how: 'pnpm secrets:local -- --regen-mtls', anchor: 'auto-generated' }) : fixed('certificados mTLS regenerados');
    },
  },
  {
    id: 'PF-29',
    title: 'OPAQUE_SERVER_SETUP presente (desde P10)',
    run: async (ctx) => {
      const pkg = join(ctx.root, 'backend/app/package.json');
      if (!existsSync(pkg) || !JSON.parse(readFileSync(pkg, 'utf8')).scripts?.['opaque:setup']) return skip('backend/app todavía no tiene opaque:setup (P10)');
      if (ctx.env.OPAQUE_SERVER_SETUP) return pass('presente');
      if (!(ctx.fix && ctx.envName === 'local')) return fail('falta OPAQUE_SERVER_SETUP', { what: 'secreto de servidor OPAQUE', variable: 'OPAQUE_SERVER_SETUP', how: 'pnpm --dir backend/app opaque:setup', anchor: 'auto-generated' });
      const r = await runAsync('pnpm', ['--dir', join(ctx.root, 'backend/app'), 'opaque:setup'], { env: { ...process.env, MTW_ENV_FILE: ctx.envFile } });
      ctx.reloadEnv();
      return r.code === 0 && ctx.env.OPAQUE_SERVER_SETUP ? fixed('generado con opaque:setup') : fail('opaque:setup falló', { what: 'OPAQUE_SERVER_SETUP', variable: 'OPAQUE_SERVER_SETUP', how: 'pnpm --dir backend/app opaque:setup', anchor: 'auto-generated' });
    },
  },
];

export const _internal = { v, VARS };
