import { isDeepStrictEqual } from "node:util";
import type { WorkflowEffectManifest } from "./effect-manifest.ts";
import { type RequestStep, WorkflowDefSchema } from "./types.ts";

type Effect = WorkflowEffectManifest["effects"][number];

export type ReadRequestSteps = ReadonlyMap<string, RequestStep>;

export interface ReadInheritanceEvidence {
  granted: ReadRequestSteps;
  next: ReadRequestSteps;
}

export const READ_RELAXED_STEP_KEYS = [
  "timeout_ms",
  "max_retries",
  "retry_backoff_ms",
  "retry_on_status",
] as const;

export const READ_RELAXED_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-language",
  "user-agent",
  "api-version",
  "x-api-version",
  "x-github-api-version",
  "notion-version",
]);

const NON_REQUEST_STEP_KEYS: ReadonlySet<string> = new Set([
  "id",
  "on_error",
  "data_selector",
  "response_filters",
  "error_policy",
  "body_schema",
  "response_schema",
  "expected_statuses",
  "expected_row_count",
  "outputs",
  "state_read",
  "state_write",
  "for_each_concurrency",
]);

const SHRINK_ONLY_STEP_LIMITS: ReadonlyArray<ReadonlyArray<string>> = [
  ["pagination", "max_pages"],
  ["pagination", "max_items"],
  ["graphql", "cursor_pagination", "max_pages"],
  ["graphql", "cursor_pagination", "max_items"],
  ["boundary", "max_calls"],
  ["boundary", "max_body_bytes"],
];

const SHRINK_ONLY_BOUNDARY_LIMITS: ReadonlyArray<ReadonlyArray<string>> = [
  ["max_calls"],
  ["max_body_bytes"],
  ["pagination", "max_requests"],
];

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parentOf(root: Json, path: ReadonlyArray<string>): Json | null {
  let cursor: unknown = root;
  for (const key of path.slice(0, -1)) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  return isRecord(cursor) ? cursor : null;
}

function dropShrunkLimits(
  granted: Json,
  next: Json,
  paths: ReadonlyArray<ReadonlyArray<string>>,
): void {
  for (const path of paths) {
    const key = path[path.length - 1];
    if (key === undefined) continue;
    const g = parentOf(granted, path);
    const n = parentOf(next, path);
    if (!g || !n) continue;
    const before = g[key];
    const after = n[key];
    if (typeof before === "number" && typeof after === "number" && after <= before) {
      delete g[key];
      delete n[key];
    }
  }
}

function literal(value: unknown): boolean {
  return typeof value === "string" && !value.includes("${");
}

function dropRelaxedHeaders(step: Json): void {
  const headers = step.headers;
  if (!isRecord(headers)) return;
  const kept: Json = {};
  for (const [name, value] of Object.entries(headers)) {
    if (READ_RELAXED_HEADERS.has(name.toLowerCase()) && literal(value)) continue;
    kept[name.toLowerCase()] = value;
  }
  if (Object.keys(kept).length === 0) delete step.headers;
  else step.headers = kept;
}

function requestShape(step: RequestStep): Json {
  const shape = clone(step) as unknown as Json;
  for (const key of NON_REQUEST_STEP_KEYS) delete shape[key];
  return shape;
}

export function readRequestUnchanged(granted: RequestStep, next: RequestStep): boolean {
  const g = requestShape(granted);
  const n = requestShape(next);
  for (const key of READ_RELAXED_STEP_KEYS) {
    delete g[key];
    delete n[key];
  }
  dropRelaxedHeaders(g);
  dropRelaxedHeaders(n);
  dropShrunkLimits(g, n, SHRINK_ONLY_STEP_LIMITS);
  return isDeepStrictEqual(g, n);
}

export function readBoundaryUnchanged(
  granted: Effect["boundary"],
  next: Effect["boundary"],
): boolean {
  if (granted === undefined || next === undefined) return isDeepStrictEqual(granted, next);
  const g = clone(granted) as unknown as Json;
  const n = clone(next) as unknown as Json;
  dropShrunkLimits(g, n, SHRINK_ONLY_BOUNDARY_LIMITS);
  return isDeepStrictEqual(g, n);
}

export function readEffectInherits(
  next: Effect,
  granted: Effect,
  evidence: ReadInheritanceEvidence,
  subBoundaries: ReadonlyArray<keyof Effect>,
): boolean | null {
  if (next.effect !== "read" || granted.effect !== "read") return null;
  if (next.call_path !== undefined || granted.call_path !== undefined) return null;
  const nextStep = evidence.next.get(next.step_id);
  const grantedStep = evidence.granted.get(granted.step_id);
  if (!nextStep || !grantedStep) return null;
  return (
    next.operation === granted.operation &&
    next.configuration_digest === granted.configuration_digest &&
    next.credential_binding_digest === granted.credential_binding_digest &&
    next.rewrites_target === granted.rewrites_target &&
    subBoundaries.every((key) =>
      key === "boundary"
        ? readBoundaryUnchanged(granted.boundary, next.boundary)
        : isDeepStrictEqual(next[key], granted[key]),
    ) &&
    readRequestUnchanged(grantedStep, nextStep)
  );
}

export function requestStepsOf(dag: unknown): ReadRequestSteps | null {
  const parsed = WorkflowDefSchema.safeParse(dag);
  if (!parsed.success) return null;
  const steps = new Map<string, RequestStep>();
  for (const step of parsed.data.steps) if (step.kind === "request") steps.set(step.id, step);
  return steps;
}
