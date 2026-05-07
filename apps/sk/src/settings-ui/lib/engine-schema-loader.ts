// Lazy loader for engine-served Zod schemas.
//
// The CLI's settings UI used to bake every Zod schema client-side,
// so each new setting required a CLI rebuild. This loader fetches
// the schema description from the engine and materializes a Zod
// shape good enough for SchemaForm's form/code modes. The engine
// returns a small, stable "schema description" payload (subset of
// JSON Schema) — we don't try to be a full converter, just cover
// the field kinds SchemaForm renders (string, number, boolean,
// enum, optional).

import { z } from "zod";

export interface EngineFieldDescriptor {
  type: "string" | "number" | "boolean" | "enum";
  optional?: boolean;
  enumValues?: readonly string[];
  description?: string;
}

export interface EngineSchemaDescriptor {
  /** Field name → kind. */
  fields: Record<string, EngineFieldDescriptor>;
}

export interface EngineSchemaSource {
  /** Fetch the descriptor for a known schema name (e.g. "settings.tenant"). */
  fetchDescriptor: (schemaName: string) => Promise<EngineSchemaDescriptor>;
}

/**
 * Materialize a Zod schema from an engine descriptor. The shape is
 * compatible with SchemaForm's `_describeFieldsForTests` walker.
 */
export function materializeSchema(
  d: EngineSchemaDescriptor,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, f] of Object.entries(d.fields)) {
    let inner: z.ZodTypeAny;
    if (f.type === "string") inner = z.string();
    else if (f.type === "number") inner = z.number();
    else if (f.type === "boolean") inner = z.boolean();
    else if (f.type === "enum") {
      const values = f.enumValues ?? [];
      if (values.length === 0) {
        // empty enum is invalid in zod; coerce to a string fallback.
        inner = z.string();
      } else {
        inner = z.enum(values as [string, ...string[]]);
      }
    } else {
      inner = z.unknown();
    }
    shape[name] = f.optional ? inner.optional() : inner;
  }
  return z.object(shape);
}

/**
 * Convenience: fetch + materialize in one call. Resolved schemas are
 * memoized per process so the settings UI doesn't re-fetch on every
 * tab toggle.
 */
const memoCache = new Map<string, z.ZodObject<Record<string, z.ZodTypeAny>>>();

export async function loadEngineSchema(
  source: EngineSchemaSource,
  schemaName: string,
  opts: { force?: boolean } = {},
): Promise<z.ZodObject<Record<string, z.ZodTypeAny>>> {
  if (!opts.force) {
    const hit = memoCache.get(schemaName);
    if (hit) return hit;
  }
  const desc = await source.fetchDescriptor(schemaName);
  const schema = materializeSchema(desc);
  memoCache.set(schemaName, schema);
  return schema;
}

export function _resetEngineSchemaCacheForTests(): void {
  memoCache.clear();
}
