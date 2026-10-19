// @vitest-environment jsdom
// La madurez de una rotación la decide el timelock con block.timestamp: la app usa la hora del último bloque (releída
// periódicamente), no el reloj del dispositivo. Y el lector de Base es uno por pestaña, en la cadena 8453.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chainReader } from './client.ts';
import { chainNowMs, useChainNow } from './time.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
});

describe('hora de la cadena', () => {
  it('timestamp del último bloque en ms', async () => {
    const reader = { getBlock: () => Promise.resolve({ timestamp: 1_800_000_000n }) } as never;
    expect(await chainNowMs(reader)).toBe(1_800_000_000_000);
  });

  it('el hook la relee cada intervalo y deja de leer al desmontar', async () => {
    vi.useFakeTimers();
    let timestamp = 1_800_000_000n;
    const getBlock = vi.fn(() => Promise.resolve({ timestamp }));
    const reader = { getBlock } as never;
    const seen: (number | null)[] = [];
    function Probe() {
      seen.push(useChainNow(reader, 1_000));
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(createElement(Probe));
      await Promise.resolve();
    });
    expect(seen.at(-1)).toBe(1_800_000_000_000);
    timestamp = 1_800_000_060n;
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(seen.at(-1)).toBe(1_800_000_060_000);
    act(() => {
      root.unmount();
    });
    const calls = getBlock.mock.calls.length;
    vi.advanceTimersByTime(5_000);
    expect(getBlock.mock.calls.length).toBe(calls);
  });

  it('el lector de Base es uno por pestaña', () => {
    const reader = chainReader('http://127.0.0.1:8545');
    expect(reader.chain.id).toBe(8453);
    expect(chainReader('http://127.0.0.1:9999')).toBe(reader);
  });
});
