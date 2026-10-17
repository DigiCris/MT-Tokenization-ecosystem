// Validador mínimo de JSON Schema (subconjunto usado por config/chains/schema.json), sin dependencias:
// type, const, enum, pattern, minimum, minLength, required, properties, additionalProperties,
// minProperties y $ref locales (#/$defs/...).

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

export function validate(schema, data, root = schema, path = '$') {
  const errors = [];
  const s = schema.$ref ? resolveRef(root, schema.$ref) : schema;
  if (s.const !== undefined && data !== s.const) errors.push(`${path}: debe ser ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(data)) errors.push(`${path}: debe ser uno de ${JSON.stringify(s.enum)}`);
  if (s.type) {
    const t = typeOf(data);
    const ok = s.type === 'number' ? t === 'number' || t === 'integer' : t === s.type;
    if (!ok) {
      errors.push(`${path}: se esperaba ${s.type}, hay ${t}`);
      return errors;
    }
  }
  if (typeof data === 'string') {
    if (s.pattern && !new RegExp(s.pattern).test(data)) errors.push(`${path}: no cumple ${s.pattern}`);
    if (s.minLength !== undefined && data.length < s.minLength) errors.push(`${path}: longitud < ${s.minLength}`);
  }
  if (typeof data === 'number' && s.minimum !== undefined && data < s.minimum) errors.push(`${path}: < ${s.minimum}`);
  if (typeOf(data) === 'object') {
    for (const k of s.required ?? []) if (!(k in data)) errors.push(`${path}: falta "${k}"`);
    if (s.minProperties !== undefined && Object.keys(data).length < s.minProperties) errors.push(`${path}: menos de ${s.minProperties} propiedades`);
    for (const [k, v] of Object.entries(data)) {
      if (s.properties?.[k]) errors.push(...validate(s.properties[k], v, root, `${path}.${k}`));
      else if (s.additionalProperties === false) errors.push(`${path}: propiedad no permitida "${k}"`);
      else if (typeof s.additionalProperties === 'object') errors.push(...validate(s.additionalProperties, v, root, `${path}.${k}`));
    }
  }
  return errors;
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`$ref no soportado: ${ref}`);
  return ref.slice(2).split('/').reduce((o, k) => o[k], root);
}
