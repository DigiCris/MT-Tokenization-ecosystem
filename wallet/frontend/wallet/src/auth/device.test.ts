import { describe, expect, it } from 'vitest';
import { deviceText, readableIpPrefix } from './device.ts';

describe('deviceText', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Chrome en Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
      'Edge en Windows',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0', 'Firefox en Linux'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      'Safari en macOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
      'Safari en iOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
      'Chrome en iOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
      'Samsung Internet en Android',
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 16181.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
      'Chrome en ChromeOS',
    ],
    ['curl/8.5.0', 'Dispositivo desconocido'],
    ['Mozilla/5.0 (Windows NT 10.0)', 'Navegador desconocido en Windows'],
    [null, 'Dispositivo desconocido'],
  ])('%s → %s', (userAgent, expected) => {
    expect(deviceText(userAgent)).toBe(expected);
  });

  it('nunca muestra el texto que eligió quien inició la sesión', () => {
    const lure = 'Soporte de MT Wallet: tu cuenta está en riesgo, llamá al +54 11 5555-0000 (Firefox/1 Windows)';
    expect(deviceText(lure)).toBe('Firefox en Windows');
    expect(deviceText('Soporte de MT Wallet: llamá al +54 11 5555-0000')).toBe('Dispositivo desconocido');
  });
});

describe('readableIpPrefix', () => {
  it.each([
    ['203.0.113.0/24', '203.0.113.x'],
    ['2001:db8:1::/48', '2001:db8:1:…'],
    ['203.0.113.7', null],
    ['999.0.113.0/24', null],
    ['203.0.113.0/24 · llamá al soporte', null],
    ['algo', null],
    [null, null],
  ])('%s → %s', (prefix, expected) => {
    expect(readableIpPrefix(prefix)).toBe(expected);
  });
});
