import { ENVELOPE_PAGINATION_FIELDS, SCOPE_ENVELOPE_FIELDS } from "../execution/engine/envelope.ts";

export const LOOP_ITEM_SCOPE_KEY = "$item";
export const LOOP_INDEX_SCOPE_KEY = "$loop_index";

const MAX_PATH_BUDGET = 64;
const MAX_DEPTH = 4;
const ARRAY_SAMPLE_FIRST_N = 1;

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

interface ScopeAtStep {
  available_paths: string[];
  shape_summary: string;
  primary_data_path: string | null;
}

export function buildScopeAtStep(value: unknown): ScopeAtStep {
  return {
    available_paths: enumerateScopePaths(value),
    shape_summary: summarizeScopeShape(value),
    primary_data_path: pickPrimaryDataPath(value),
  };
}

export function renderScopeShapeContract(): string[] {
  return [
    "- It receives exactly one value, `input`:",
    `  - \`input.scope.<step_id>.data\` — an upstream step's result; its envelope { ${SCOPE_ENVELOPE_FIELDS.join(", ")} } also carries the HTTP \`.status_code\`, a failure \`.error\` ({ code, message } or null) and page totals \`.pagination\` { ${ENVELOPE_PAGINATION_FIELDS.join(", ")} }`,
    "  - `input.input` — the workflow input",
    `  - \`input.scope.${LOOP_ITEM_SCOPE_KEY}\` / \`input.scope.${LOOP_INDEX_SCOPE_KEY}\` — the current item and its 0-based index inside a loop body`,
    "- `output_transform_function` is different: its `input` is only the final value (the last step's data), not `{ scope, input }`.",
  ];
}
