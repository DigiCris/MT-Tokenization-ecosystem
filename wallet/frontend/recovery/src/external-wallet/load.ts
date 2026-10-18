// Único punto de entrada al chunk de wallet externa ([F-SEC-07], P16.T02): wagmi y los conectores se cargan sólo con
// este import() dinámico; ningún flujo de R interna lo importa (test/bundle-graph.test.ts lo verifica sobre el build).
export function loadExternalWallet() {
  return import('./index.ts');
}
