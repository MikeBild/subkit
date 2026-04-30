// Pure helpers that turn an arbitrary `output_preview` value into the
// authoring-time vocabulary the LLM needs to compose downstream
// transforms / loops without guessing at JSONata paths.
//
// `enumerateScopePaths` walks the value and emits every readable
// JSONata-style path up to a depth + count budget. `summarizeScopeShape`
// produces a one-line shape summary ("object{count,results[3]}") for
// the same value.
//
// Pre-fix the LLM had to guess the post-selector shape from the
// connector docs; sessions like ebd66982 burned 3+ retries on
// `$scope.X.data` vs. `$scope.X` vs. `X.data` because the actual
// envelope was never echoed back. step_trace + scope_at_step + the
// `suggest_jsonata_paths` tool all share these helpers so the output
// is uniform across surfaces.

const MAX_PATH_BUDGET = 64;
const MAX_DEPTH = 4;
/** Number of array indices we expand when recording paths. The first
 * element is always recorded as `[0]`; if more elements exist we add
 * a `[*]` synthetic path so the LLM knows the array is iterable. */
const ARRAY_SAMPLE_FIRST_N = 1;

/** A primitive type label in the shape grammar. */
type PrimitiveLabel = "string" | "number" | "boolean" | "null" | "undefined";

function classifyPrimitive(value: unknown): PrimitiveLabel | null {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return null;
  }
}

/**
 * Walk `value` and emit JSONata-shaped paths ("a.b", "items[0].id",
 * "items[*].id"). Stops at MAX_DEPTH and MAX_PATH_BUDGET so a runaway
 * preview can't blow the token budget.
 */
export function enumerateScopePaths(
  value: unknown,
  options?: { root_prefix?: string; depth_budget?: number; path_budget?: number },
): string[] {
  const rootPrefix = options?.root_prefix ?? "";
  const depthBudget = options?.depth_budget ?? MAX_DEPTH;
  const pathBudget = options?.path_budget ?? MAX_PATH_BUDGET;
  const out: string[] = [];

  const walk = (v: unknown, path: string, depth: number): void => {
    if (out.length >= pathBudget) return;
    if (depth > depthBudget) return;
    if (path.length > 0 && !out.includes(path)) out.push(path);
    if (out.length >= pathBudget) return;
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      // Record first N elements as concrete indices so the LLM can copy
      // them directly. Add a `[*]` synthetic path when the array has
      // more entries — JSONata doesn't accept literal `[*]`, but we
      // include it as documentation that the array is iterable; the
      // LLM should write `items.id` (JSONata fanout) for the same
      // effect.
      const sampleCount = Math.min(ARRAY_SAMPLE_FIRST_N, v.length);
      for (let i = 0; i < sampleCount; i++) {
        if (out.length >= pathBudget) return;
        walk(v[i], `${path}[${i}]`, depth + 1);
      }
      if (v.length > ARRAY_SAMPLE_FIRST_N && depth + 1 <= depthBudget) {
        const wildcard = `${path}[*]`;
        if (!out.includes(wildcard) && out.length < pathBudget) out.push(wildcard);
      }
      return;
    }
    if (typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (out.length >= pathBudget) return;
        const childPath = path ? `${path}.${k}` : k;
        walk(child, childPath, depth + 1);
      }
    }
  };

  walk(value, rootPrefix, 0);
  return out;
}

/**
 * One-line shape summary. Examples:
 *   - `string`
 *   - `array[12]`
 *   - `object{count,results[12]}`
 *   - `array[3]<object>`
 */
export function summarizeScopeShape(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array[0]";
    const first = value[0];
    const childKind = describeKind(first);
    return childKind === null ? `array[${value.length}]` : `array[${value.length}]<${childKind}>`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return "object{}";
    // Inline up to 3 keys, with array-length annotation where useful.
    const previews = keys.slice(0, 3).map((k) => {
      const child = (value as Record<string, unknown>)[k];
      if (Array.isArray(child)) return `${k}[${child.length}]`;
      return k;
    });
    const more = keys.length > previews.length ? `,…+${keys.length - previews.length}` : "";
    return `object{${previews.join(",")}${more}}`;
  }
  return classifyPrimitive(value) ?? "unknown";
}

function describeKind(v: unknown): string | null {
  if (v === null) return "null";
  if (v === undefined) return null;
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return classifyPrimitive(v);
}

/**
 * Best-guess "where the actual data lives" path — useful for
 * `$scope.<id>.<primary_data_path>` recommendations the LLM can drop
 * straight into a downstream transform / loop.
 *
 * Heuristics, in order:
 *  1. value is an array → ""
 *  2. value is an object with one key → recurse into that key
 *  3. value is an object with a key whose name is in a small "this is
 *     the payload" allow-list (`data`, `results`, `items`, `records`,
 *     `rows`, `entries`, `payload`, `body`) → return that key
 *  4. otherwise → null
 */
export function pickPrimaryDataPath(value: unknown, depth = 0): string | null {
  if (depth > 3 || value === null || value === undefined) return null;
  if (Array.isArray(value)) return "";
  if (typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;
  const PAYLOAD_KEYS = [
    "data",
    "results",
    "items",
    "records",
    "rows",
    "entries",
    "payload",
    "body",
  ];
  for (const candidate of PAYLOAD_KEYS) {
    if (candidate in obj) {
      const child = pickPrimaryDataPath(obj[candidate], depth + 1);
      return child !== null && child.length > 0 ? `${candidate}.${child}` : candidate;
    }
  }
  if (keys.length === 1) {
    const only = keys[0]!;
    const child = pickPrimaryDataPath(obj[only], depth + 1);
    return child !== null && child.length > 0 ? `${only}.${child}` : only;
  }
  return null;
}

/**
 * One-shot envelope describing the scope at a step. Mirrors what
 * `dry_run_workflow.step_trace[i].scope_at_step` returns and what
 * `suggest_jsonata_paths` consumes.
 */
export interface ScopeAtStep {
  /** Up to 64 readable JSONata paths (relative — no `$scope.<id>.`
   * prefix; callers prepend that themselves). */
  available_paths: string[];
  /** One-line shape summary (`object{count,results[12]}`). */
  shape_summary: string;
  /** Best guess at where the iterable / primary payload lives, or null
   * if not obvious. */
  primary_data_path: string | null;
}

/** Build a `ScopeAtStep` envelope from an arbitrary preview value. */
export function buildScopeAtStep(value: unknown): ScopeAtStep {
  return {
    available_paths: enumerateScopePaths(value),
    shape_summary: summarizeScopeShape(value),
    primary_data_path: pickPrimaryDataPath(value),
  };
}
