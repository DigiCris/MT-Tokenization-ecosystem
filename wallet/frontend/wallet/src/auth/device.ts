// De dónde es una sesión, para leerlo en la lista de sesiones y en los avisos. El user-agent llega del backend tal como
// lo mandó quien inició la sesión: lo elige esa persona (un atacante puede poner "Soporte: llamá al …"), así que nunca se
// muestra crudo. Se reduce a un navegador y un sistema que la app conoce ("Chrome en Windows") y lo demás queda como
// "Dispositivo desconocido". El prefijo de IP lo calcula el backend; igual sólo se muestra si tiene la forma esperada.

const BROWSERS: readonly [RegExp, string][] = [
  // Los que se basan en Chromium también dicen "Chrome/": van antes.
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: readonly [RegExp, string][] = [
  // Un iPhone o un Android también nombran otros sistemas ("like Mac OS X", "Linux"): van antes.
  [/\biPhone\b|\biPad\b|\biPod\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMacintosh\b|\bMac OS X\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

const first = (list: readonly [RegExp, string][], userAgent: string) =>
  list.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;

/** El dispositivo de una sesión con nombres de la app ("Firefox en Linux"); nunca el texto del user-agent. */
export function deviceText(userAgent: string | null): string {
  if (userAgent === null) return 'Dispositivo desconocido';
  const browser = first(BROWSERS, userAgent);
  const system = first(SYSTEMS, userAgent);
  if (browser !== null && system !== null) return `${browser} en ${system}`;
  if (browser !== null) return browser;
  return system === null ? 'Dispositivo desconocido' : `Navegador desconocido en ${system}`;
}

/**
 * El prefijo de IP que guarda el backend ("203.0.113.0/24", "2001:db8:1::/48") como se lee: "203.0.113.x",
 * "2001:db8:1:…". Algo que no tiene esa forma no se muestra (null).
 */
export function readableIpPrefix(prefix: string | null): string | null {
  if (prefix === null) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/.exec(prefix);
  if (v4) {
    const octets = v4.slice(1, 4).map(Number);
    return octets.every((octet) => octet <= 255) ? `${octets.join('.')}.x` : null;
  }
  const v6 = /^([0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})::\/\d{1,3}$/i.exec(prefix);
  return v6?.[1] ? `${v6[1]}:…` : null;
}
