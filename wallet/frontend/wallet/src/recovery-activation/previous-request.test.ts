// @vitest-environment jsdom
// Hallazgo 2 de la tercera revisión de P17.MAN: el onboarding sabe que ya hubo un pedido de R para la wallet después de
// recargar la pestaña o de volver a montar el paso, por una marca de la pestaña (sessionStorage, sólo el id de la
// wallet) o por la R que ya informa la plataforma; sin storage, no falla.
import { afterEach, describe, expect, it } from 'vitest';
import { readTabFlag, writeTabFlag } from '../storage/flags.ts';
import { hadOnboardingRequest, markOnboardingRequest } from './previous-request.ts';

const WALLET = '0B6B3C1E-2F3A-4C5D-8E9F-0A1B2C3D4E5F';
const OTHER = '7d2e3f40-1a2b-4c5d-8e9f-a0b1c2d3e4f5';
const R = '0x7184D30100a188c9F869ccB6883392534ecD6C9d';

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('pedido de R anterior en el onboarding', () => {
  it('sin marca ni R informada no hubo pedido; con la marca de esta pestaña, sí (sólo para esa wallet)', () => {
    expect(hadOnboardingRequest(WALLET)).toBe(false);
    markOnboardingRequest(WALLET);
    expect(hadOnboardingRequest(WALLET.toLowerCase())).toBe(true);
    expect(hadOnboardingRequest(OTHER)).toBe(false);
    // La marca es de la pestaña (sessionStorage) y lleva sólo el id de la wallet.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(1);
    expect(window.sessionStorage.key(0)).toBe('mtw.flag.onboarding.recoveryRequest');
    expect(window.sessionStorage.getItem('mtw.flag.onboarding.recoveryRequest')).toBe(WALLET.toLowerCase());
  });

  it('una R que ya informa la plataforma también cuenta (otra pestaña o dispositivo, o la marca se perdió)', () => {
    expect(hadOnboardingRequest(WALLET, R)).toBe(true);
    expect(hadOnboardingRequest(WALLET, null)).toBe(false);
  });

  it('las marcas de la pestaña validan nombre y valor como los flags, y sin storage no fallan', () => {
    expect(() => {
      writeTabFlag('Mal nombre', 'x');
    }).toThrow('flag inválido');
    expect(() => {
      writeTabFlag('ok.nombre', 'valor con espacios');
    }).toThrow('valor de flag inválido');
    expect(() => readTabFlag('Mal nombre')).toThrow('flag inválido');
    const session = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('bloqueado', 'SecurityError');
      },
    });
    try {
      markOnboardingRequest(WALLET);
      expect(hadOnboardingRequest(WALLET)).toBe(false);
    } finally {
      if (session) Object.defineProperty(window, 'sessionStorage', session);
    }
  });
});
