import { and, desc, eq, isNull } from "drizzle-orm";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Executor, getDb } from "../db/client.ts";
import { schemaVersions } from "../db/schema/index.ts";
import type { SchemaShape } from "../self-healing/types.ts";

export function deriveShape(value: unknown): SchemaShape {
  if (value === null) return { type: "null" };
  const t = typeof value;
  if (t === "string") return { type: "string" };
  if (t === "number") return { type: "number" };
  if (t === "boolean") return { type: "boolean" };
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array", items: { type: "unknown" } };
    let items = deriveShape(value[0]);
    for (let i = 1; i < value.length; i++) {
      items = mergeObservedShapes(items, deriveShape(value[i]));
    }
    return { type: "array", items };
  }
  if (t === "object") {
    const out: Record<string, SchemaShape> = {};
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [k, v] of entries) {
      out[k] = deriveShape(v);
    }
    return { type: "object", properties: out };
  }
  return { type: "unknown" };
}

export function mergeObservedShapes(previous: SchemaShape, observed: SchemaShape): SchemaShape {
  return mergeShapes(previous, observed, true);
}

function mergeShapes(
  previous: SchemaShape,
  observed: SchemaShape,
  refineUnknown: boolean,
): SchemaShape {
  if (previous.type === "unknown") return refineUnknown ? observed : previous;
  if (observed.type === "unknown") return previous;
  if (previous.type !== observed.type) return { type: "unknown" };
  if (previous.type === "array" && observed.type === "array") {
    return { type: "array", items: mergeShapes(previous.items, observed.items, true) };
  }
  if (previous.type === "object" && observed.type === "object") {
    const properties: Record<string, SchemaShape> = {};
    const keys = new Set([
      ...Object.keys(previous.properties),
      ...Object.keys(observed.properties),
    ]);
    for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
      const before = previous.properties[key];
      const after = observed.properties[key];
      if (before && after) properties[key] = mergeShapes(before, after, false);
      else if (before) properties[key] = before;
      else if (after) properties[key] = after;
    }
    return { type: "object", properties };
  }
  return previous;
}

function shapesEqual(left: SchemaShape, right: SchemaShape): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "array" && right.type === "array") {
    return shapesEqual(left.items, right.items);
  }
  if (left.type === "object" && right.type === "object") {
    const leftKeys = Object.keys(left.properties);
    const rightKeys = Object.keys(right.properties);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => {
      const leftValue = left.properties[key];
      const rightValue = right.properties[key];
      return (
        leftValue !== undefined && rightValue !== undefined && shapesEqual(leftValue, rightValue)
      );
    });
  }
  return true;
}

export function graphqlEndpointKey(operation_name: string): string {
  return `POST /graphql#${operation_name || "anonymous"}`;
}

export interface RecordShapeParams {
  tenant_id: string;
  connector_id: string;
  endpoint_key: string;
  workflow_id?: string | null;
  step_id?: string | null;
  value: unknown;
}

export async function recordSuccessShape(p: RecordShapeParams, exec?: Executor): Promise<string> {
  const db: Executor = exec ?? getDb();
  const observed = deriveShape(p.value);
  const workflowCondition = p.workflow_id
    ? eq(schemaVersions.workflow_id, p.workflow_id)
    : isNull(schemaVersions.workflow_id);
  const stepCondition = p.step_id
    ? eq(schemaVersions.step_id, p.step_id)
    : isNull(schemaVersions.step_id);
  const latest = await db
    .select({ id: schemaVersions.id, schema: schemaVersions.schema })
    .from(schemaVersions)
    .where(
      and(
        eq(schemaVersions.tenant_id, p.tenant_id),
        eq(schemaVersions.connector_id, p.connector_id),
        eq(schemaVersions.endpoint_key, p.endpoint_key),
        workflowCondition,
        stepCondition,
      ),
    )
    .orderBy(desc(schemaVersions.seen_at))
    .limit(1);
  const latestRow = latest[0];
  const shape = latestRow
    ? mergeObservedShapes(latestRow.schema as unknown as SchemaShape, observed)
    : observed;
  if (latestRow && shapesEqual(latestRow.schema as unknown as SchemaShape, shape)) {
    return latestRow.id;
  }
  const [row] = await db
    .insert(schemaVersions)
    .values({
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      endpoint_key: p.endpoint_key,
      workflow_id: p.workflow_id ?? null,
      step_id: p.step_id ?? null,
      schema: shape as unknown as Record<string, unknown>,
      observed_schema: observed as unknown as Record<string, unknown>,
    })
    .returning({ id: schemaVersions.id });
  assertInsertRow(row, "schema_versions");
  return row.id;
}

export interface GetLatestShapeParams {
  tenant_id: string;
  connector_id: string;
  endpoint_key: string;
  workflow_id?: string;
  step_id?: string;
}

export interface LatestEndpointShape {
  endpoint_key: string;
  shape: SchemaShape;
  seen_at: Date;
}

export async function listLatestShapes(
  p: { tenant_id: string; connector_id: string; max_endpoints?: number },
  exec?: Executor,
): Promise<LatestEndpointShape[]> {
  const db: Executor = exec ?? getDb();
  const maxEndpoints = p.max_endpoints ?? 4;
  const rows = await db
    .select({
      endpoint_key: schemaVersions.endpoint_key,
      schema: schemaVersions.schema,
      seen_at: schemaVersions.seen_at,
    })
    .from(schemaVersions)
    .where(
      and(
        eq(schemaVersions.tenant_id, p.tenant_id),
        eq(schemaVersions.connector_id, p.connector_id),
      ),
    )
    .orderBy(desc(schemaVersions.seen_at))
    .limit(100);
  const out: LatestEndpointShape[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.endpoint_key)) continue;
    seen.add(row.endpoint_key);
    out.push({
      endpoint_key: row.endpoint_key,
      shape: row.schema as unknown as SchemaShape,
      seen_at: row.seen_at,
    });
    if (out.length >= maxEndpoints) break;
  }
  return out;
}

export async function getLatestShape(
  p: GetLatestShapeParams,
  exec?: Executor,
): Promise<SchemaShape | null> {
  const db: Executor = exec ?? getDb();
  const conditions = [
    eq(schemaVersions.connector_id, p.connector_id),
    eq(schemaVersions.endpoint_key, p.endpoint_key),
  ];
  if (p.workflow_id) conditions.push(eq(schemaVersions.workflow_id, p.workflow_id));
  if (p.step_id) conditions.push(eq(schemaVersions.step_id, p.step_id));
  const rows = await db
    .select()
    .from(schemaVersions)
    .where(and(eq(schemaVersions.tenant_id, p.tenant_id), ...conditions))
    .orderBy(desc(schemaVersions.seen_at))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return row.schema as unknown as SchemaShape;
}

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

export interface ShapeHistoryEntry {
  schema: SchemaShape;
  seen_at: Date;
}

export async function listShapeHistory(
  p: GetLatestShapeParams & { limit?: number },
  exec?: Executor,
): Promise<ShapeHistoryEntry[]> {
  const db: Executor = exec ?? getDb();
  const conditions = [
    eq(schemaVersions.connector_id, p.connector_id),
    eq(schemaVersions.endpoint_key, p.endpoint_key),
  ];
  if (p.workflow_id) conditions.push(eq(schemaVersions.workflow_id, p.workflow_id));
  if (p.step_id) conditions.push(eq(schemaVersions.step_id, p.step_id));
  const rows = await db
    .select()
    .from(schemaVersions)
    .where(and(eq(schemaVersions.tenant_id, p.tenant_id), ...conditions))
    .orderBy(desc(schemaVersions.seen_at))
    .limit(p.limit ?? 50);
  return rows.map((r) => ({
    schema: (r.observed_schema ?? r.schema) as unknown as SchemaShape,
    seen_at: r.seen_at,
  }));
}

export interface MigrationStep {
  kind: "rename" | "add" | "remove" | "widen";
  path: string;
  from?: string;
  to_type?: SchemaShape["type"];
  safe: boolean;
}

export interface MigrationPlan {
  steps: MigrationStep[];
  fully_safe: boolean;
  before: SchemaShape;
  after: SchemaShape;
}

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
  const fl = from.toLowerCase();
  const tl = to.toLowerCase();
  if (fl.endsWith(tl) || tl.endsWith(fl)) score += 25;
  const norm = (s: string): string => s.toLowerCase().replace(/[_-]/g, "");
  if (norm(from) === norm(to)) score += 50;
  return score;
}

export async function proposeSchemaMigration(
  p: GetLatestShapeParams,
  exec?: Executor,
): Promise<MigrationPlan | null> {
  const history = await listShapeHistory(p, exec);
  const newest = history[0];
  const oldest = history[history.length - 1];
  if (!newest || !oldest) return null;
  const after = newest.schema;
  const before = oldest.schema;
  const { added, removed, widened } = diffShapesDeep(before, after);

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
      if (getPath(cloned, step.path) === undefined) {
        setPath(cloned, step.path, null);
      }
    } else if (step.kind === "remove") {
      deletePath(cloned, step.path);
    }
  }
  return cloned;
}
