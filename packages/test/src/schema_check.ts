/**
 * A small JSON Schema checker for this package's contracts (`contracts/*.schema.json`):
 * the subset they use — type (one or a list), const, enum, required, properties,
 * additionalProperties, items, minimum, anyOf, and $ref into the same document's $defs.
 * It lets a consumer (and our tests) hold JSON to a contract without a dependency.
 */

type Schema = Readonly<Record<string, unknown>>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

/** Every way `value` breaks `schema`, as "<path>: <problem>" (empty: it conforms). */
export function validate(schema: Schema, value: unknown, root: Schema = schema, path = '$'): string[] {
  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const name = /^#\/\$defs\/(.+)$/.exec(ref)?.[1];
    const target = name === undefined ? undefined : (root['$defs'] as Record<string, Schema> | undefined)?.[name];
    if (target === undefined) return [`${path}: unresolvable $ref ${ref}`];
    return validate(target, value, root, path);
  }
  const out: string[] = [];
  const anyOf = schema['anyOf'] as Schema[] | undefined;
  if (anyOf !== undefined && !anyOf.some((s) => validate(s, value, root, path).length === 0)) {
    out.push(`${path}: matches none of anyOf`);
  }
  const type = schema['type'] as string | string[] | undefined;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => matchesType(value, t))) return [...out, `${path}: expected ${types.join(' | ')}, got ${typeOf(value)}`];
  }
  if ('const' in schema && JSON.stringify(schema['const']) !== JSON.stringify(value)) out.push(`${path}: expected ${JSON.stringify(schema['const'])}`);
  const values = schema['enum'] as unknown[] | undefined;
  if (values !== undefined && !values.some((v) => JSON.stringify(v) === JSON.stringify(value))) out.push(`${path}: not one of ${JSON.stringify(values)}`);
  const minimum = schema['minimum'];
  if (typeof minimum === 'number' && typeof value === 'number' && value < minimum) out.push(`${path}: below ${minimum}`);
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of (schema['required'] as string[] | undefined) ?? []) if (!(key in obj)) out.push(`${path}: missing "${key}"`);
    const properties = (schema['properties'] as Record<string, Schema> | undefined) ?? {};
    for (const [key, v] of Object.entries(obj)) {
      const sub = properties[key];
      if (sub !== undefined) out.push(...validate(sub, v, root, `${path}.${key}`));
      else if (schema['additionalProperties'] === false) out.push(`${path}: unexpected "${key}"`);
      else if (typeof schema['additionalProperties'] === 'object') out.push(...validate(schema['additionalProperties'] as Schema, v, root, `${path}.${key}`));
    }
  }
  if (Array.isArray(value) && schema['items'] !== undefined) {
    value.forEach((v, i) => out.push(...validate(schema['items'] as Schema, v, root, `${path}[${i}]`)));
  }
  return out;
}
