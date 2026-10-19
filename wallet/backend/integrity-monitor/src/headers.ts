// Headers de seguridad servidos ([F-SEC-01], [F-SEC-03], [F-SEC-04]) contra los que declara el propio release en
// `.well-known/security-headers.json` (archivo del manifest, ya verificado por hash): los generales en toda respuesta y
// los de cada ruta (p. ej. la cámara sólo en las rutas que escanean QR); un pedido de script de service worker → 403.
import { z } from 'zod';

const HeadersSchema = z.record(z.string().min(1), z.string());
export const HeaderSpecSchema = z
  .object({
    environment: z.string(),
    headers: HeadersSchema,
    routes: z.record(z.string().regex(/^\/[A-Za-z0-9/_-]*$/), HeadersSchema),
  })
  .strict();
export type HeaderSpec = z.infer<typeof HeaderSpecSchema>;

/** Headers esperados para una ruta: los generales más los de su ruta (o de la ruta que la contiene). */
export function expectedHeaders(spec: HeaderSpec, pathname: string): Record<string, string> {
  const route = Object.keys(spec.routes).find((r) => pathname === r || pathname.startsWith(`${r}/`));
  return route === undefined ? spec.headers : { ...spec.headers, ...spec.routes[route] };
}

/** Diferencias entre lo servido y lo esperado (nombres sin distinguir mayúsculas; los valores, exactos). */
export function headerProblems(path: string, served: Headers, expected: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(expected)) {
    const actual = served.get(name);
    if (actual === null) problems.push(`${path}: falta el header ${name}`);
    else if (actual !== value) problems.push(`${path}: el header ${name} no coincide con el release`);
  }
  return problems;
}
