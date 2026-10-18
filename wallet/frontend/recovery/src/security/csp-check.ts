// Comprobación al arrancar de que la CSP está activa y se aplica ([F-SEC-02], P16.T04): (1) el navegador tiene que
// soportar Trusted Types; (2) crear una política con otro nombre tiene que fallar (`trusted-types mtw-default`); y (3)
// asignar un string a un sink de script tiene que fallar (`require-trusted-types-for 'script'`; el <script> nunca se
// inserta en el documento). Con Trusted Types exigido y sin política `default`, eval y `new Function` sobre un string
// también quedan bloqueados. Si alguna prueba falla, la app se niega a operar. Cada prueba superada genera una
// violación esperada: el reporter descuenta exactamente esas.
export type CspCheckFailure = 'TRUSTED_TYPES_UNSUPPORTED' | 'TRUSTED_TYPES_NOT_ENFORCED';

export const CSP_PROBE_POLICY = 'mtw-csp-probe';

/** Claves de las violaciones que generan las pruebas (directiva efectiva + recurso bloqueado + muestra). */
export const EXPECTED_PROBE_VIOLATIONS = [
  `trusted-types|trusted-types-policy|${CSP_PROBE_POLICY}`,
  'require-trusted-types-for|trusted-types-sink|HTMLScriptElement text',
] as const;

export interface CspProbes {
  trustedTypes: TrustedTypePolicyFactory | undefined;
  assignScriptSink: () => void;
}

export function browserProbes(): CspProbes {
  return {
    trustedTypes: window.trustedTypes,
    assignScriptSink: () => {
      document.createElement('script').text = ''; // nosemgrep: mtw-fe-dynamic-script (nunca se inserta)
    },
  };
}

export function checkCsp(probes: CspProbes = browserProbes()): CspCheckFailure | null {
  if (probes.trustedTypes === undefined) return 'TRUSTED_TYPES_UNSUPPORTED';
  try {
    probes.trustedTypes.createPolicy(CSP_PROBE_POLICY, {});
    return 'TRUSTED_TYPES_NOT_ENFORCED';
  } catch {
    // Nombre de política no permitido: lo esperado.
  }
  try {
    probes.assignScriptSink();
    return 'TRUSTED_TYPES_NOT_ENFORCED';
  } catch {
    return null;
  }
}
