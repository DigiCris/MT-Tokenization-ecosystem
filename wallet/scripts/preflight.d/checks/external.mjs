// PF-19…PF-22 y PF-30…PF-32: servicios externos reales (WalletConnect, Google OAuth, email,
// Etherscan, Drive, Gmail y Mailgun). Valida sin mostrar valores ni tokens.
import { fetchWithTimeout, readBanner } from '../lib/net.mjs';
import { pass, fail, skip } from '../lib/report.mjs';

async function googleAccessToken(clientId, clientSecret, refreshToken) {
  const res = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`token endpoint HTTP ${res.status} (${body.error ?? 'sin access_token'})`);
  return { token: body.access_token, scope: body.scope ?? '' };
}

const basicAuth = (key) => 'Basic ' + Buffer.from(`api:${key}`).toString('base64');

export const externalChecks = [
  {
    id: 'PF-19',
    title: 'WALLETCONNECT_PROJECT_ID válido (relay real de Reown)',
    run: async (ctx) => {
      const id = ctx.env.WALLETCONNECT_PROJECT_ID ?? '';
      const opt = { variable: 'WALLETCONNECT_PROJECT_ID', how: 'copiar el Project ID desde dashboard.reown.com', anchor: 'walletconnect_project_id' };
      if (!id) return fail('ausente', opt);
      if (!/^[0-9a-f]{32}$/.test(id)) return fail('formato inválido (32 hex)', opt);
      try {
        const res = await fetchWithTimeout(`https://rpc.walletconnect.org/v1/?chainId=eip155:8453&projectId=${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ctx.env.RECOVERY_ORIGIN ?? 'http://localhost:5174' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) return fail(`el relay rechazó el projectId (HTTP ${res.status})`, opt);
        if (!res.ok || body.result !== '0x2105') return fail(`respuesta inesperada del relay (HTTP ${res.status})`, opt);
        return pass('projectId aceptado por el relay (eth_chainId 0x2105)');
      } catch (e) {
        return fail(`relay inaccesible: ${e.message}`, opt);
      }
    },
  },
  {
    id: 'PF-20',
    title: 'Google OAuth client IDs (Wallet y Recovery)',
    run: async (ctx) => {
      const pairs = [
        ['GOOGLE_CLIENT_ID_WALLET', 'GOOGLE_OAUTH_REDIRECT_URI_WALLET', 'google_client_id_wallet'],
        ['GOOGLE_CLIENT_ID_RECOVERY', 'GOOGLE_OAUTH_REDIRECT_URI_RECOVERY', 'google_client_id_recovery'],
      ];
      if (ctx.env.GOOGLE_CLIENT_ID_WALLET && ctx.env.GOOGLE_CLIENT_ID_WALLET === ctx.env.GOOGLE_CLIENT_ID_RECOVERY) {
        return fail('Wallet y Recovery usan el mismo client ID', { variable: 'GOOGLE_CLIENT_ID_RECOVERY', how: 'crear un proyecto y cliente propio para Recovery', anchor: 'google_client_id_recovery' });
      }
      for (const [idVar, redirVar, anchor] of pairs) {
        const id = ctx.env[idVar] ?? '';
        const redirect = ctx.env[redirVar] ?? '';
        const opt = { variable: idVar, how: 'revisar el cliente OAuth (tipo Web application) y su redirect URI en Google Cloud', anchor };
        if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id)) return fail(`${idVar} con formato inválido`, opt);
        const q = new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: 'token', scope: 'https://www.googleapis.com/auth/drive.appdata' });
        try {
          const res = await fetchWithTimeout(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, { redirect: 'manual' });
          const text = res.status >= 300 && res.status < 400 ? res.headers.get('location') ?? '' : await res.text();
          const err = ['redirect_uri_mismatch', 'invalid_client', 'deleted_client', 'disabled_client', 'unauthorized_client'].find((x) => text.includes(x));
          if (err || !(res.status >= 300 && res.status < 400)) return fail(`${idVar}: Google respondió ${err ?? `HTTP ${res.status}`}`, opt);
        } catch (e) {
          return fail(`${idVar}: no se pudo consultar a Google (${e.message})`, opt);
        }
      }
      return pass('ambos clientes existen y aceptan su redirect URI');
    },
  },
  {
    id: 'PF-21',
    title: 'Proveedor de email (local: Mailpit; mailgun: dominio activo)',
    run: async (ctx) => {
      const e = ctx.env;
      if (e.EMAIL_PROVIDER === 'smtp') {
        try {
          const banner = await readBanner(Number(e.SMTP_PORT), e.SMTP_HOST);
          if (!banner.startsWith('220')) return fail(`SMTP respondió "${banner.slice(0, 40)}"`, { variable: 'SMTP_HOST, SMTP_PORT', how: 'docker compose up -d mailpit', anchor: 'servicios-locales-docker-compose' });
          const r = await fetchWithTimeout(`http://127.0.0.1:${e.MAILPIT_UI_PORT}/api/v1/info`, {}, 5000);
          if (!r.ok) return fail(`Mailpit API HTTP ${r.status}`, { variable: 'MAILPIT_UI_PORT', how: 'docker compose up -d mailpit', anchor: 'servicios-locales-docker-compose' });
          return pass('Mailpit SMTP + API');
        } catch (err) {
          return fail(`SMTP local inaccesible: ${err.message}`, { variable: 'SMTP_HOST, SMTP_PORT', how: 'docker compose up -d mailpit', anchor: 'servicios-locales-docker-compose' });
        }
      }
      return checkMailgunDomain(e);
    },
  },
  {
    id: 'PF-22',
    title: 'ETHERSCAN_API_KEY válida (API V2, chainid 8453)',
    run: async (ctx) => {
      const key = ctx.env.ETHERSCAN_API_KEY;
      if (!key) return ctx.envName === 'local' ? skip('no definida (se usa en el despliegue final)') : fail('ETHERSCAN_API_KEY ausente', { variable: 'ETHERSCAN_API_KEY', how: 'crear la key en etherscan.io', anchor: 'etherscan_api_key' });
      try {
        const q = new URLSearchParams({ chainid: '8453', module: 'contract', action: 'getsourcecode', address: ctx.chainConfig.contracts.usdc.address, apikey: key });
        const res = await fetchWithTimeout(`https://api.etherscan.io/v2/api?${q}`);
        const body = await res.json().catch(() => ({}));
        if (body.status !== '1') return fail(`Etherscan respondió status ${body.status ?? res.status} (${String(body.message ?? '').slice(0, 40)})`, { variable: 'ETHERSCAN_API_KEY', how: 'verificar la key en etherscan.io', anchor: 'etherscan_api_key' });
        return pass('key aceptada para el módulo de contratos en Base');
      } catch (e) {
        return fail(`Etherscan inaccesible: ${e.message}`, { variable: 'ETHERSCAN_API_KEY', how: 'reintentar', anchor: 'etherscan_api_key' });
      }
    },
  },
  {
    id: 'PF-30',
    title: 'Drive real: refresh token de prueba y appDataFolder',
    envs: ['local', 'ci'],
    run: async (ctx) => {
      const e = ctx.env;
      const opt = { variable: 'GOOGLE_DRIVE_TEST_CLIENT_ID, GOOGLE_DRIVE_TEST_CLIENT_SECRET, GOOGLE_DRIVE_TEST_REFRESH_TOKEN', how: 'regenerar el refresh token en OAuth Playground (scope drive.appdata)', anchor: 'google_drive_test_client_id--google_drive_test_client_secret--google_drive_test_refresh_token' };
      try {
        const { token, scope } = await googleAccessToken(e.GOOGLE_DRIVE_TEST_CLIENT_ID, e.GOOGLE_DRIVE_TEST_CLIENT_SECRET, e.GOOGLE_DRIVE_TEST_REFRESH_TOKEN);
        if (!scope.includes('drive.appdata')) return fail('el token no tiene el scope drive.appdata', opt);
        const res = await fetchWithTimeout('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&pageSize=1', { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) return fail(`appDataFolder respondió HTTP ${res.status} (¿Drive API habilitada?)`, opt);
        return pass('token válido (drive.appdata) y appDataFolder accesible');
      } catch (err) {
        return fail(err.message, opt);
      }
    },
  },
  {
    id: 'PF-31',
    title: 'Gmail real: refresh token de prueba (gmail.readonly) y casilla correcta',
    envs: ['local', 'ci'],
    run: async (ctx) => {
      const e = ctx.env;
      const opt = { variable: 'EMAIL_TEST_GOOGLE_CLIENT_ID, EMAIL_TEST_GOOGLE_CLIENT_SECRET, EMAIL_TEST_GOOGLE_REFRESH_TOKEN, EMAIL_TEST_ADDRESS', how: 'regenerar el refresh token en OAuth Playground (scope gmail.readonly) con la cuenta de prueba', anchor: 'email_test_address--email_test_google_refresh_token' };
      try {
        const { token, scope } = await googleAccessToken(e.EMAIL_TEST_GOOGLE_CLIENT_ID, e.EMAIL_TEST_GOOGLE_CLIENT_SECRET, e.EMAIL_TEST_GOOGLE_REFRESH_TOKEN);
        if (!scope.includes('gmail.readonly')) return fail('el token no tiene el scope gmail.readonly', opt);
        const res = await fetchWithTimeout('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) return fail(`Gmail API respondió HTTP ${res.status} (¿Gmail API habilitada?)`, opt);
        const profile = await res.json();
        if (String(profile.emailAddress).toLowerCase() !== String(e.EMAIL_TEST_ADDRESS).toLowerCase()) return fail('el token pertenece a otra casilla que EMAIL_TEST_ADDRESS', opt);
        return pass('token válido (gmail.readonly) para EMAIL_TEST_ADDRESS');
      } catch (err) {
        return fail(err.message, opt);
      }
    },
  },
  {
    id: 'PF-32',
    title: 'Mailgun real para los tests (API key y Events API)',
    envs: ['local', 'ci'],
    run: async (ctx) => {
      const e = ctx.env;
      const dom = await checkMailgunDomain(e);
      if (dom.status !== 'PASS') return dom;
      try {
        const res = await fetchWithTimeout(`${e.EMAIL_PROVIDER_BASE_URL}/v3/${e.EMAIL_PROVIDER_DOMAIN}/events?limit=1`, { headers: { authorization: basicAuth(e.EMAIL_PROVIDER_API_KEY) } });
        if (!res.ok) return fail(`Events API HTTP ${res.status}`, { variable: 'EMAIL_PROVIDER_API_KEY', how: 'verificar la API key en Mailgun (API Security)', anchor: 'email_provider_api_key--email_from' });
        return pass(`dominio ${dom.detail.replace(/^dominio /, '')}; Events API 200`);
      } catch (err) {
        return fail(`Mailgun inaccesible: ${err.message}`, { variable: 'EMAIL_PROVIDER_BASE_URL', how: 'reintentar', anchor: 'email_provider_api_key--email_from' });
      }
    },
  },
];

async function checkMailgunDomain(e) {
  const opt = { variable: 'EMAIL_PROVIDER_API_KEY, EMAIL_PROVIDER_DOMAIN, EMAIL_PROVIDER_BASE_URL', how: 'verificar la API key y el dominio en app.mailgun.com', anchor: 'email_provider_api_key--email_from' };
  try {
    const res = await fetchWithTimeout(`${e.EMAIL_PROVIDER_BASE_URL}/v3/domains/${e.EMAIL_PROVIDER_DOMAIN}`, { headers: { authorization: basicAuth(e.EMAIL_PROVIDER_API_KEY) } });
    if (res.status === 401) return fail('Mailgun rechazó la API key (401)', opt);
    if (!res.ok) return fail(`Mailgun respondió HTTP ${res.status} para el dominio`, opt);
    const body = await res.json();
    if (body.domain?.state !== 'active') return fail(`el dominio está en estado ${body.domain?.state}`, opt);
    return pass(`dominio activo (${body.domain.type})`);
  } catch (err) {
    return fail(`Mailgun inaccesible: ${err.message}`, opt);
  }
}
