'use strict';

// Minimal JSON Schema (draft-07 subset) validator — only the keywords used by
// contracts/mcp-skill-sources.schema.json. Keeps L1 hermetic: no npm dependency,
// no network schema resolution. Returns a list of "path: message" strings.

function pointer(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref: ${ref}`);
  return ref.slice(2).split('/').reduce((node, key) => node[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validate(schema, data, { root = schema, path = '$' } = {}) {
  const errors = [];
  if (schema.$ref) return validate(pointer(root, schema.$ref), data, { root, path });

  if (schema.const !== undefined && data !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${path}: ${JSON.stringify(data)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  const t = schema.type;
  if (t) {
    const actual = typeOf(data);
    const ok = t === 'integer' ? Number.isInteger(data) : t === 'number' ? (actual === 'number') : actual === t;
    if (!ok) return [...errors, `${path}: expected type ${t}, got ${actual}`];
  }
  if (t === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(data))) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (t === 'array') {
    if (schema.minItems !== undefined && data.length < schema.minItems) errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    if (schema.uniqueItems) {
      const seen = new Set(data.map((v) => JSON.stringify(v)));
      if (seen.size !== data.length) errors.push(`${path}: items are not unique`);
    }
    if (schema.items) data.forEach((item, i) => errors.push(...validate(schema.items, item, { root, path: `${path}[${i}]` })));
  }
  if (t === 'object') {
    if (schema.required) {
      for (const key of schema.required) if (!(key in data)) errors.push(`${path}: missing required property "${key}"`);
    }
    for (const [key, value] of Object.entries(data)) {
      const prop = schema.properties && schema.properties[key];
      if (prop) errors.push(...validate(prop, value, { root, path: `${path}.${key}` }));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${key}"`);
    }
  }
  return errors;
}

module.exports = { validate };
