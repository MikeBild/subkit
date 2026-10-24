import { isDeepStrictEqual } from "node:util";
import { Kind, OperationTypeNode, parse } from "graphql";
import type { WorkflowEffectManifest } from "./effect-manifest.ts";
import { hasRuntimeValue } from "./report-delivery-boundary.ts";
import { type RequestStep, WorkflowDefSchema } from "./types.ts";

type Effect = WorkflowEffectManifest["effects"][number];

export type ReadRequestSteps = ReadonlyMap<string, RequestStep>;

export interface ReadInheritanceEvidence {
  granted: ReadRequestSteps;
  next: ReadRequestSteps;
}

export interface ReadComparison {
  relaxed: string[];
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

const MAX_GRAPHQL_TOKENS = 10_000;

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
  relaxed: string[],
  prefix = "",
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
      if (after !== before) relaxed.push(`${prefix}${path.join(".")}`);
      delete g[key];
      delete n[key];
    }
  }
}

function literal(value: unknown): boolean {
  return typeof value === "string" && !value.includes("${");
}

function dropRelaxedHeaders(step: Json): Json {
  const headers = step.headers;
  const dropped: Json = {};
  if (!isRecord(headers)) return dropped;
  const kept: Json = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (READ_RELAXED_HEADERS.has(lower) && literal(value)) dropped[lower] = value;
    else kept[lower] = value;
  }
  if (Object.keys(kept).length === 0) delete step.headers;
  else step.headers = kept;
  return dropped;
}

function sameKeys(a: Json, b: Json): boolean {
  return isDeepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort());
}

function changedKeys(a: Json, b: Json, prefix: string): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => !isDeepStrictEqual(a[key], b[key]))
    .map((key) => `${prefix}${key}`);
}

function relaxQueryValues(granted: Json, next: Json, relaxed: string[]): void {
  const before = granted.query;
  const after = next.query;
  if (!isRecord(before) || !isRecord(after) || !sameKeys(before, after)) return;
  if (hasRuntimeValue(before) || hasRuntimeValue(after)) return;
  relaxed.push(...changedKeys(before, after, "query."));
  delete granted.query;
  delete next.query;
}

function pureQueryDocument(source: string): boolean {
  try {
    const document = parse(source, { noLocation: true, maxTokens: MAX_GRAPHQL_TOKENS });
    let operations = 0;
    for (const definition of document.definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) continue;
      if (
        definition.kind !== Kind.OPERATION_DEFINITION ||
        definition.operation !== OperationTypeNode.QUERY
      )
        return false;
      operations++;
    }
    return operations > 0;
  } catch {
    return false;
  }
}

function relaxGraphqlVariables(granted: Json, next: Json, relaxed: string[]): void {
  const before = granted.graphql;
  const after = next.graphql;
  if (!isRecord(before) || !isRecord(after)) return;
  if (typeof before.query !== "string" || before.query !== after.query) return;
  if (![before.operation, after.operation].every((op) => op === undefined || op === "query"))
    return;
  const beforeVariables = before.variables ?? {};
  const afterVariables = after.variables ?? {};
  if (!isRecord(beforeVariables) || !isRecord(afterVariables)) return;
  if (!sameKeys(beforeVariables, afterVariables)) return;
  if (hasRuntimeValue(beforeVariables) || hasRuntimeValue(afterVariables)) return;
  if (!pureQueryDocument(before.query)) return;
  relaxed.push(...changedKeys(beforeVariables, afterVariables, "graphql.variables."));
  delete before.variables;
  delete after.variables;
}

function requestShape(step: RequestStep): Json {
  const shape = clone(step) as unknown as Json;
  for (const key of NON_REQUEST_STEP_KEYS) delete shape[key];
  return shape;
}

function compareReadRequests(
  granted: RequestStep,
  next: RequestStep,
  options: { queryValues: boolean },
): ReadComparison | null {
  const g = requestShape(granted);
  const n = requestShape(next);
  const relaxed: string[] = [];
  for (const key of READ_RELAXED_STEP_KEYS) {
    if (!isDeepStrictEqual(g[key], n[key])) relaxed.push(key);
    delete g[key];
    delete n[key];
  }
  relaxed.push(...changedKeys(dropRelaxedHeaders(g), dropRelaxedHeaders(n), "headers."));
  dropShrunkLimits(g, n, SHRINK_ONLY_STEP_LIMITS, relaxed);
  if (options.queryValues) relaxQueryValues(g, n, relaxed);
  relaxGraphqlVariables(g, n, relaxed);
  return isDeepStrictEqual(g, n) ? { relaxed } : null;
}

function compareReadBoundaries(
  granted: Effect["boundary"],
  next: Effect["boundary"],
  relaxed: string[],
): boolean {
  if (granted === undefined || next === undefined) return isDeepStrictEqual(granted, next);
  const g = clone(granted) as unknown as Json;
  const n = clone(next) as unknown as Json;
  dropShrunkLimits(g, n, SHRINK_ONLY_BOUNDARY_LIMITS, relaxed, "boundary.");
  return isDeepStrictEqual(g, n);
}

export function readEffectInherits(
  next: Effect,
  granted: Effect,
  evidence: ReadInheritanceEvidence,
  subBoundaries: ReadonlyArray<keyof Effect>,
): ReadComparison | false | null {
  if (next.effect !== "read" || granted.effect !== "read") return null;
  if (next.call_path !== undefined || granted.call_path !== undefined) return null;
  const nextStep = evidence.next.get(next.step_id);
  const grantedStep = evidence.granted.get(granted.step_id);
  if (!nextStep || !grantedStep) return null;
  if (
    next.operation !== granted.operation ||
    next.configuration_digest !== granted.configuration_digest ||
    next.credential_binding_digest !== granted.credential_binding_digest ||
    next.rewrites_target !== granted.rewrites_target
  )
    return false;
  const relaxed: string[] = [];
  const boundariesHold = subBoundaries.every((key) =>
    key === "boundary"
      ? compareReadBoundaries(granted.boundary, next.boundary, relaxed)
      : isDeepStrictEqual(next[key], granted[key]),
  );
  if (!boundariesHold) return false;
  const request = compareReadRequests(grantedStep, nextStep, {
    queryValues: granted.read_query === undefined && next.read_query === undefined,
  });
  if (!request) return false;
  return { relaxed: [...new Set([...relaxed, ...request.relaxed])].sort() };
}

export function requestStepsOf(dag: unknown): ReadRequestSteps | null {
  const parsed = WorkflowDefSchema.safeParse(dag);
  if (!parsed.success) return null;
  const steps = new Map<string, RequestStep>();
  for (const step of parsed.data.steps) if (step.kind === "request") steps.set(step.id, step);
  return steps;
}
