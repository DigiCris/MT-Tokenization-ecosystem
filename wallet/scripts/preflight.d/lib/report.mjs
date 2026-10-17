// Modelo de resultados y salida del preflight. Nunca imprime valores de variables.
export const PASS = 'PASS';
export const FIXED = 'FIXED';
export const WARN = 'WARN';
export const SKIP = 'SKIP';
export const FAIL = 'FAIL';

export const SETUP_DOC = 'docs/SETUP_EXTERNAL_SERVICES.md';

export const pass = (detail = '') => ({ status: PASS, detail });
export const fixed = (detail = '') => ({ status: FIXED, detail });
export const warn = (detail = '') => ({ status: WARN, detail });
export const skip = (detail = '') => ({ status: SKIP, detail });
/** FAIL con instrucciones: qué falta, variable, cómo obtenerla y documento interno (con ancla). */
export const fail = (detail, { what, variable = '—', how, anchor } = {}) => ({
  status: FAIL,
  detail,
  fix: { what: what ?? detail, variable, how: how ?? 'ver documento', doc: anchor ? `${SETUP_DOC}#${anchor}` : SETUP_DOC },
});

const ICON = { PASS: 'ok  ', FIXED: 'fix ', WARN: 'warn', SKIP: 'skip', FAIL: 'FAIL' };

export function render(results, { json = false } = {}) {
  // PF-33 es el resumen: no se cuenta ni se detalla como una falla propia.
  const failed = results.filter((r) => r.status === FAIL && r.id !== 'PF-33');
  if (json) {
    return JSON.stringify({ passed: failed.length === 0, results }, null, 2) + '\n';
  }
  const lines = [];
  for (const r of results) lines.push(`[${ICON[r.status]}] ${r.id} ${r.title}${r.detail ? ` — ${r.detail}` : ''}`);
  const skipped = results.filter((r) => r.status === SKIP);
  if (skipped.length) lines.push('', `Omitidos (${skipped.length}): ${skipped.map((r) => r.id).join(', ')} — motivo en cada línea.`);
  if (failed.length) {
    lines.push('', `STOP: ${failed.length} check(s) obligatorio(s) en FAIL.`);
    for (const r of failed) {
      lines.push('', `${r.id} ${r.title}`, `  qué falta:        ${r.fix.what}`, `  variable:         ${r.fix.variable}`, `  cómo obtenerla:   ${r.fix.how}`, `  documento:        ${r.fix.doc}`);
    }
  } else {
    lines.push('', 'PREFLIGHT PASSED');
  }
  return lines.join('\n') + '\n';
}
