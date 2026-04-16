// Schema-version tracking.
//
// A request step that succeeds records a canonicalized shape for
// `(connector_id, endpoint_key)` in the `schema_versions` table. The
// self-healing loop reads the most recent row back when it diffs a
// failing response. Keeping one insert-per-success is cheap because
// `seen_at` is indexed and lookups are a single `ORDER BY seen_at DESC
// LIMIT 1`.

import { and, desc, eq } from "drizzle-orm";
import { type Db, getDb } from "../db/client.ts";
import { schemaVersions } from "../db/schema/index.ts";
import type { SchemaShape } from "../self-healing/types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Derive a SchemaShape from an arbitrary JSON value. The result is a
 * recursive description of the shape, *not* the data — scalars become
 * `{type: "string"}` etc., arrays become `{type: "array", items:
 * <shape>}`, and objects become `{type: "object", properties: {…}}`.
 *
 * Arrays collapse to the first element's shape. A mixed-type array
 * (e.g. `[1, "two"]`) widens to `{type: "unknown"}` for safety — the
 * canonical ordering of JSON Schema is out of scope for a drift
 * detector that just wants to know whether a field disappeared.
 */
export function deriveShape(value: unknown): SchemaShape {
  if (value === null) return { type: "null" };
  const t = typeof value;
  if (t === "string") return { type: "string" };
  if (t === "number") return { type: "number" };
  if (t === "boolean") return { type: "boolean" };
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array", items: { type: "unknown" } };
    const head = deriveShape(value[0]);
    // Narrow the array item type by checking that all elements share
    // the same top-level kind. Anything else widens to unknown.
    for (let i = 1; i < value.length; i++) {
      const next = deriveShape(value[i]);
      if (next.type !== head.type) return { type: "array", items: { type: "unknown" } };
    }
    return { type: "array", items: head };
  }
  if (t === "object") {
    const out: Record<string, SchemaShape> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deriveShape(v);
    }
    return { type: "object", properties: out };
  }
  return { type: "unknown" };
}

export interface RecordShapeParams {
  tenant_id: string;
  connector_id: string;
  endpoint_key: string;
  value: unknown;
}

/**
 * Record the shape of a successful response. Called from the request
 * driver's happy path; the self-healing loop reads the most recent row
 * back via `getLatestShape`.
 */
export async function recordSuccessShape(p: RecordShapeParams, exec?: Executor): Promise<string> {
  const db: Executor = exec ?? getDb();
  const shape = deriveShape(p.value);
  const [row] = await db
    .insert(schemaVersions)
    .values({
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      endpoint_key: p.endpoint_key,
      schema: shape as unknown as Record<string, unknown>,
    })
    .returning({ id: schemaVersions.id });
  if (!row) throw new Error("schema_versions insert returned no row");
  return row.id;
}

export interface GetLatestShapeParams {
  tenant_id: string;
  connector_id: string;
  endpoint_key: string;
}

export async function getLatestShape(
  p: GetLatestShapeParams,
  exec?: Executor,
): Promise<SchemaShape | null> {
  const db: Executor = exec ?? getDb();
  const rows = await db
    .select()
    .from(schemaVersions)
    .where(
      and(
        eq(schemaVersions.tenant_id, p.tenant_id),
        eq(schemaVersions.connector_id, p.connector_id),
        eq(schemaVersions.endpoint_key, p.endpoint_key),
      ),
    )
    .orderBy(desc(schemaVersions.seen_at))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return row.schema as unknown as SchemaShape;
}

/**
 * Diff two schema shapes at the top level. Produces three sets:
 *   - `added`   keys present on `after` but not `before`
 *   - `removed` keys present on `before` but not `after`
 *   - `widened` keys whose `before` type disagrees with `after`
 *
 * The diff is *shallow* — we only look at the first level of object
 * keys. Deeper drift shows up as a `widened` entry because the child
 * shape object-compares unequal. The detector layer renders this into
 * a human-readable line for the LLM prompt.
 */
export function diffShapes(
  before: SchemaShape,
  after: SchemaShape,
): { added: string[]; removed: string[]; widened: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const widened: string[] = [];
  if (before.type !== "object" || after.type !== "object") {
    if (before.type !== after.type) widened.push("$");
    return { added, removed, widened };
  }
  const bKeys = new Set(Object.keys(before.properties));
  const aKeys = new Set(Object.keys(after.properties));
  for (const k of aKeys) if (!bKeys.has(k)) added.push(k);
  for (const k of bKeys) if (!aKeys.has(k)) removed.push(k);
  for (const k of aKeys) {
    if (!bKeys.has(k)) continue;
    const bs = before.properties[k];
    const as = after.properties[k];
    if (!bs || !as) continue;
    if (bs.type !== as.type) widened.push(k);
  }
  return { added, removed, widened };
}
