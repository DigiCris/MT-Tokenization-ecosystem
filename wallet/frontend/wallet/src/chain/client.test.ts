// Un cliente de lectura de Base por pestaña, con el RPC del frontend.
import { describe, expect, it } from 'vitest';
import { frontendClient } from './client.ts';

describe('cliente del RPC del frontend', () => {
  it('es uno solo y de Base (8453)', () => {
    const client = frontendClient('http://127.0.0.1:8545');
    expect(frontendClient('http://otro')).toBe(client);
    expect(client.chain.id).toBe(8453);
  });
});
