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

import { debugLog } from "../../debug.ts";

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

export class EngineSchemaError extends Error {
  readonly field: string;
  readonly reason: "empty_enum_values" | "unknown_field_type";
  constructor(field: string, reason: "empty_enum_values" | "unknown_field_type", message: string) {
    super(message);
    this.name = "EngineSchemaError";
    this.field = field;
    this.reason = reason;
  }
}

/**
 * Materialize a Zod schema from an engine descriptor. The shape is
 * compatible with SchemaForm's `_describeFieldsForTests` walker.
 *
 * Strict: an empty enum or an unknown field type **throws** an
 * `EngineSchemaError` — silent fallbacks were a bug.
 * Dropped the previous `permissive: true` escape hatch
 * because no in-tree caller used it (YAGNI). Re-add when a real
 * bug-report path needs the fallback shape.
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
        debugLog(
          "settings.schema_fallback",
          { field: name, descriptor_type: "enum", reason: "empty_enum_values" },
          {},
        );
        throw new EngineSchemaError(
          name,
          "empty_enum_values",
          `field "${name}" is declared as enum but the engine returned no enumValues`,
        );
      }
      inner = z.enum(values as [string, ...string[]]);
    } else {
      debugLog(
        "settings.schema_fallback",
        { field: name, descriptor_type: f.type, reason: "unknown_field_type" },
        {},
      );
      throw new EngineSchemaError(
        name,
        "unknown_field_type",
        `field "${name}" has unsupported descriptor type "${f.type}"`,
      );
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
