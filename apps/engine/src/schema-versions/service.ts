// Schema-version tracking.
//
// A request step that succeeds records a canonicalized shape for
// `(connector_id, endpoint_key)` in the `schema_versions` table. The
// self-healing loop reads the most recent row back when it diffs a
// failing response. Keeping one insert-per-success is cheap because
// `seen_at` is indexed and lookups are a single `ORDER BY seen_at DESC
// LIMIT 1`.

import { and, desc, eq } from "drizzle-orm";
import { assertInsertRow } from "../db/assert-insert.ts";
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
  // Dedup: skip the insert when the latest recorded shape is identical.
  // Without this a workflow on a minute schedule writes one row per run
  // forever (unbounded table growth) while `getLatestShape` only ever
  // reads the newest row — the steady state is one row per actual shape
  // CHANGE, which is exactly the granularity the drift detector needs.
  const latest = await db
    .select({ id: schemaVersions.id, schema: schemaVersions.schema })
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
  const latestRow = latest[0];
  if (latestRow && JSON.stringify(latestRow.schema) === JSON.stringify(shape)) {
    return latestRow.id;
  }
  const [row] = await db
    .insert(schemaVersions)
    .values({
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      endpoint_key: p.endpoint_key,
      schema: shape as unknown as Record<string, unknown>,
    })
    .returning({ id: schemaVersions.id });
  assertInsertRow(row, "schema_versions");
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

/**
 * Deep diff — walks both shapes recursively and emits path-qualified
 * entries. Paths use dot notation (`user.address.city`) and `[]` for
 * array element shapes (`orders[].id`). The shallow `diffShapes` is
 * still preferred when callers only care about the top-level surface
 * (drift detection); `diffShapesDeep` powers the migration tooling
 * where path-level detail matters.
 */
export function diffShapesDeep(
  before: SchemaShape,
  after: SchemaShape,
  prefix = "",
): { added: string[]; removed: string[]; widened: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const widened: string[] = [];
  const join = (suffix: string): string => (prefix ? `${prefix}.${suffix}` : suffix);

  if (before.type !== after.type) {
    widened.push(prefix || "$");
    return { added, removed, widened };
  }

  if (before.type === "object" && after.type === "object") {
    const bKeys = new Set(Object.keys(before.properties));
    const aKeys = new Set(Object.keys(after.properties));
    for (const k of aKeys) if (!bKeys.has(k)) added.push(join(k));
    for (const k of bKeys) if (!aKeys.has(k)) removed.push(join(k));
    for (const k of aKeys) {
      if (!bKeys.has(k)) continue;
      const bs = before.properties[k]!;
      const as = after.properties[k]!;
      const sub = diffShapesDeep(bs, as, join(k));
      added.push(...sub.added);
      removed.push(...sub.removed);
      widened.push(...sub.widened);
    }
    return { added, removed, widened };
  }

  if (before.type === "array" && after.type === "array") {
    const sub = diffShapesDeep(before.items, after.items, `${prefix}[]`);
    added.push(...sub.added);
    removed.push(...sub.removed);
    widened.push(...sub.widened);
    return { added, removed, widened };
  }

  return { added, removed, widened };
}

/* ------------------------------------------------------------------ */
/* Schema-evolution / migration tooling                                */
/* ------------------------------------------------------------------ */

export interface ShapeHistoryEntry {
  schema: SchemaShape;
  seen_at: Date;
}

/**
 * Walk every recorded shape for an endpoint in chronological order.
 * Powers "how has this endpoint changed over time?" — the same
 * question the reference impl can't answer because it has no
 * versioning. Caller decides the depth (default 50).
 */
export async function listShapeHistory(
  p: GetLatestShapeParams & { limit?: number },
  exec?: Executor,
): Promise<ShapeHistoryEntry[]> {
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
    .limit(p.limit ?? 50);
  return rows.map((r) => ({
    schema: r.schema as unknown as SchemaShape,
    seen_at: r.seen_at,
  }));
}

export interface MigrationStep {
  /** Action category — informational; rename/add are usually safe to
   *  auto-apply, remove is a breaking change that needs operator review. */
  kind: "rename" | "add" | "remove" | "widen";
  path: string;
  /** For `rename`, the previous key the migration retargets from. */
  from?: string;
  /** For `widen`, the new type observed (e.g. "string" → "number"). */
  to_type?: SchemaShape["type"];
  /** Whether this step is safe to auto-apply (rename/add/widen) or
   *  needs manual review (remove). */
  safe: boolean;
}

export interface MigrationPlan {
  /** First → latest summary, with one entry per detected change. */
  steps: MigrationStep[];
  /** True when EVERY step is safe to auto-apply. Dashboards / repair
   *  tooling can use this as the green-light signal. */
  fully_safe: boolean;
  /** Echoed for caller convenience. */
  before: SchemaShape;
  after: SchemaShape;
}

/**
 * Levenshtein distance between two strings — used by the rename
 * heuristic to weight name similarity alongside type compatibility.
 * Pure function; bounded loop. Returns 0 for identical inputs.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const prev = new Array<number>(bl + 1);
  const cur = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= bl; j++) prev[j] = cur[j]!;
  }
  return prev[bl]!;
}

/**
 * Score a rename candidate. Higher is better. Combines:
 *   - name similarity (Levenshtein, normalised to length)
 *   - same type bonus
 *   - tail-match bonus (`user_id` ↔ `id`, `order_id` ↔ `orderId`, etc.)
 */
function renameScore(
  from: string,
  to: string,
  fromType: SchemaShape["type"] | undefined,
  toType: SchemaShape["type"] | undefined,
): number {
  const maxLen = Math.max(from.length, to.length);
  const lev = levenshtein(from.toLowerCase(), to.toLowerCase());
  const similarity = maxLen === 0 ? 0 : 1 - lev / maxLen;
  let score = similarity * 100;
  if (fromType && fromType === toType) score += 30;
  // Tail match — common API rename pattern (foo_id ↔ id).
  const fl = from.toLowerCase();
  const tl = to.toLowerCase();
  if (fl.endsWith(tl) || tl.endsWith(fl)) score += 25;
  // Camel/snake equivalence
  const norm = (s: string): string => s.toLowerCase().replace(/[_-]/g, "");
  if (norm(from) === norm(to)) score += 50;
  return score;
}

/**
 * Compare the FIRST recorded shape with the LATEST shape and emit a
 * structured migration plan. The deep-diff variant captures
 * path-qualified changes for nested objects and array element shapes.
 *
 * Renames are detected via combined name-similarity + type-compatibility
 * scoring (not just type-only): `user_id` → `id` pairs even when both
 * are integers in a sea of other integer fields, because the tail-match
 * bonus dominates a same-type-by-coincidence pairing.
 *
 * Empty plan (`steps: []`) means the endpoint is shape-stable across
 * its history — nothing to migrate.
 */
export async function proposeSchemaMigration(
  p: GetLatestShapeParams,
  exec?: Executor,
): Promise<MigrationPlan | null> {
  const history = await listShapeHistory(p, exec);
  // history is ordered newest → oldest; pick first-recorded vs latest.
  const newest = history[0];
  const oldest = history[history.length - 1];
  if (!newest || !oldest) return null;
  const after = newest.schema;
  const before = oldest.schema;
  const { added, removed, widened } = diffShapesDeep(before, after);

  // Helper to pick a property's type by deep path. Returns undefined
  // if any segment doesn't resolve as an object property.
  const lookupType = (shape: SchemaShape, path: string): SchemaShape["type"] | undefined => {
    const parts = path.split(".").filter(Boolean);
    let cur: SchemaShape = shape;
    for (const part of parts) {
      if (part.endsWith("[]")) {
        const key = part.slice(0, -2);
        if (key) {
          if (cur.type !== "object") return undefined;
          cur = cur.properties[key]!;
          if (!cur) return undefined;
        }
        if (cur.type !== "array") return undefined;
        cur = cur.items;
        continue;
      }
      if (cur.type !== "object") return undefined;
      cur = cur.properties[part]!;
      if (!cur) return undefined;
    }
    return cur.type;
  };

  // Pair up rename candidates with the new scoring heuristic. For
  // each removed path, score every available added path; pick the
  // best match above a threshold (60 — empirically chosen so an
  // unrelated rename doesn't drag through random adds/removes).
  const RENAME_THRESHOLD = 60;
  const renamedFrom = new Set<string>();
  const renamedTo = new Set<string>();
  const renames: Array<{ from: string; to: string; score: number }> = [];
  for (const oldKey of removed) {
    const oldType = lookupType(before, oldKey);
    let bestScore = -1;
    let bestMatch: string | null = null;
    for (const newKey of added) {
      if (renamedTo.has(newKey)) continue;
      const newType = lookupType(after, newKey);
      const score = renameScore(oldKey, newKey, oldType, newType);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = newKey;
      }
    }
    if (bestMatch && bestScore >= RENAME_THRESHOLD) {
      renames.push({ from: oldKey, to: bestMatch, score: bestScore });
      renamedFrom.add(oldKey);
      renamedTo.add(bestMatch);
    }
  }

  const steps: MigrationStep[] = [];
  for (const r of renames) {
    steps.push({ kind: "rename", path: r.to, from: r.from, safe: true });
  }
  for (const a of added) {
    if (renamedTo.has(a)) continue;
    steps.push({ kind: "add", path: a, safe: true });
  }
  for (const r of removed) {
    if (renamedFrom.has(r)) continue;
    steps.push({ kind: "remove", path: r, safe: false });
  }
  for (const w of widened) {
    const toType = lookupType(after, w);
    const step: MigrationStep = { kind: "widen", path: w, safe: true };
    if (toType) step.to_type = toType;
    steps.push(step);
  }
  return {
    steps,
    fully_safe: steps.every((s) => s.safe),
    before,
    after,
  };
}

/**
 * Apply a migration plan to a sample value, returning a transformed
 * copy. Renames retarget keys (deep-path), adds inject `null` at the
 * target path so downstream consumers can branch on presence, removes
 * delete keys, and widens are no-ops on the data (the schema widened,
 * but values that fit the old type still fit the new one — the type
 * change is metadata).
 *
 * Plans whose `safe` is false (i.e. include any `remove`) still apply,
 * but the caller should gate behind operator approval.
 *
 * Pure function — input is not mutated. Designed for the workflow
 * `output_transform` use case: operators can paste this transformation
 * into a transform step or use it to migrate cached fixtures.
 */
export function applyMigration<T>(plan: MigrationPlan, value: T): T {
  const cloned = JSON.parse(JSON.stringify(value)) as T;

  const setPath = (target: unknown, path: string, val: unknown): void => {
    const parts = path.split(".").filter(Boolean);
    if (parts.length === 0) return;
    let cur: unknown = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (part.endsWith("[]")) {
        const key = part.slice(0, -2);
        if (cur && typeof cur === "object" && key) cur = (cur as Record<string, unknown>)[key];
        if (Array.isArray(cur)) {
          for (const entry of cur) setPath(entry, parts.slice(i + 1).join("."), val);
          return;
        }
        return;
      }
      if (!cur || typeof cur !== "object") return;
      cur = (cur as Record<string, unknown>)[part];
    }
    const last = parts[parts.length - 1]!;
    if (cur && typeof cur === "object") {
      (cur as Record<string, unknown>)[last] = val;
    }
  };

  const getPath = (target: unknown, path: string): unknown => {
    const parts = path.split(".").filter(Boolean);
    let cur: unknown = target;
    for (const part of parts) {
      if (!cur || typeof cur !== "object") return undefined;
      const key = part.endsWith("[]") ? part.slice(0, -2) : part;
      cur = (cur as Record<string, unknown>)[key];
    }
    return cur;
  };

  const deletePath = (target: unknown, path: string): void => {
    const parts = path.split(".").filter(Boolean);
    if (parts.length === 0) return;
    let cur: unknown = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (!cur || typeof cur !== "object") return;
      cur = (cur as Record<string, unknown>)[part.endsWith("[]") ? part.slice(0, -2) : part];
    }
    const last = parts[parts.length - 1]!;
    if (cur && typeof cur === "object") {
      delete (cur as Record<string, unknown>)[last];
    }
  };

  for (const step of plan.steps) {
    if (step.kind === "rename" && step.from) {
      const carried = getPath(cloned, step.from);
      if (carried !== undefined) {
        setPath(cloned, step.path, carried);
        deletePath(cloned, step.from);
      }
    } else if (step.kind === "add") {
      // Inject null only when the path doesn't already exist; never
      // overwrite a real value.
      if (getPath(cloned, step.path) === undefined) {
        setPath(cloned, step.path, null);
      }
    } else if (step.kind === "remove") {
      deletePath(cloned, step.path);
    }
    // widen is a no-op on the data plane.
  }
  return cloned;
}
