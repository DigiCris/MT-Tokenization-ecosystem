// P19.T06 [W-05]: bordes del documento soberano importado (firmas mal formadas, rol desconocido, fecha inválida) y el
// archivo que se descarga (JSON legible, nombre con el hash y los roles que ya firmaron).
import { describe, expect, it } from 'vitest';
import sovereignVector from '../../test/vectors/wire/sovereign.json' with { type: 'json' };
import { parseSovereignDocument, SovereignDocumentError, sovereignFile, sovereignFileName } from './document.ts';

const file = sovereignVector.file as unknown as Record<string, unknown> & { signatures: Record<string, unknown>[] };

describe('documento importado', () => {
  it.each([
    ['una firma que no es un objeto', { signatures: ['0x00'] }],
    ['un rol desconocido', { signatures: [{ ...file.signatures[0], role: 'S' }] }],
    ['una firma de otro largo', { signatures: [{ ...file.signatures[0], signature: '0x1234' }] }],
    ['un firmante inválido', { signatures: [{ ...file.signatures[0], signer: '0x12' }] }],
    ['una fecha inválida', { createdAt: 'ayer' }],
    ['firmas que no son una lista', { signatures: {} }],
  ])('%s: no se usa', (_, patch) => {
    expect(() => parseSovereignDocument({ ...file, ...patch })).toThrow(SovereignDocumentError);
  });
});

describe('archivo descargable', () => {
  it('JSON legible y nombre con el hash y los roles firmantes', () => {
    const doc = parseSovereignDocument(file);
    expect(JSON.parse(sovereignFile(doc))).toEqual(doc);
    expect(sovereignFile(doc).endsWith('\n')).toBe(true);
    expect(sovereignFileName(doc)).toBe(`mtw-sovereign-${doc.safeTxHash.slice(2, 10)}-RU.json`);
    expect(sovereignFileName({ ...doc, signatures: [] })).toBe(
      `mtw-sovereign-${doc.safeTxHash.slice(2, 10)}-sin-firmas.json`,
    );
  });
});
