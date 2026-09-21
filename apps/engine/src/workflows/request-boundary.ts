// An author-declared boundary for one HTTP request step.
//
// The effect-manifest compiler refuses every request step that carries a runtime
// placeholder, because a substituted value can change where a request goes or
// what it does. The existing exemptions are each shaped around one case (a
// report e-mail, a revision upload, a GET with a variable id). This is the
// general one: the AUTHOR states what may vary, a human reviews exactly that
// statement, and the runtime holds every dispatch to it before any network I/O.
//
// Two rules keep review and dispatch from disagreeing, which is the defect this
// module exists to avoid:
//
//   ONE resolver. The reviewed target is produced by the same `resolveUrl` the
//   driver dispatches through. Reviewing with `new URL(path, base)` instead
//   silently drops a base path such as `/v2` — the grant is approved for a URL
//   the run can never produce, and every dispatch is then denied.
//
//   ONE matcher. `matchTarget` decides both "could an approved value ever reach
//   this target" at review and "is this concrete request inside the boundary"
//   at dispatch.
//
// Scope of this first slice, on purpose: whole path segments bound by an
// explicit `enum`, a static query, a runtime body bounded by size. Anything it
// cannot hold to a reviewed statement is REFUSED with a named reason rather
// than accepted loosely — placeholders in the query or headers, a placeholder
// that is only part of a segment, pagination.

import { z } from "@hono/zod-openapi";
import { resolveUrl } from "../connectors/drivers/resolve-url.ts";
import type { MaterializedRequest } from "../execution/prepared-request.ts";
import { hasRuntimeValue } from "./report-delivery-boundary.ts";
import type { RequestStep } from "./types.ts";

/** A placeholder expression without its `${}`: `input.site`, `item.id`, `scope.plan.data.id`. */
const expression = z.string().regex(/^(?:item|input|scope)(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/);
/**
 * A value an approved variable may take. Unreserved URL characters only, so a
 * value can never introduce a `/`, a query, an encoded traversal or a second
 * segment, and what the reviewer reads is byte-for-byte what may be sent.
 */
const enumValue = z
  .string()
  .regex(/^[A-Za-z0-9._~-]{1,200}$/)
  .refine((value) => value !== "." && value !== "..");
const rule = z.object({ enum: z.array(enumValue).min(1).max(50) }).strict();
export type RequestVariableRule = z.infer<typeof rule>;

export const RequestBoundaryScopeSchema = z
  .object({
    /** One entry per `${…}` in the path, keyed by the expression. `{}` for a static path. */
    variables: z.record(expression, rule),
    max_body_bytes: z.number().int().min(0).max(10_000_000),
    // A reviewed ceiling shown to the human. NOT a per-run count the engine
    // enforces yet — nothing counts dispatches across a run (see
    // `authority-execution-shape.ts`, `run_limit_is_request_limit: false`).
    max_calls: z.number().int().min(1).max(10_000),
    /** Required for DELETE, so a removal is never approved by omission. */
    // The default "expected true" reads as an instruction to set it; the first
    // author to meet it did exactly that on a request that removes nothing.
    destructive: z
      .literal(true, {
        error:
          "`destructive` exists only to mark a request that removes or irreversibly changes data, " +
          "and may then only be `true`. For any other request OMIT the key; do not set it to false " +
          "and do not set it to true to satisfy this check.",
      })
      .optional(),
  })
  .strict();
export type RequestBoundaryScope = z.infer<typeof RequestBoundaryScopeSchema>;

const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export const RequestBoundarySchema = z
  .object({
    base_url: z.string().url().nullable(),
    method: z.enum(HTTP_METHODS),
    origin: z.string().url(),
    /** Resolved path segments; a variable segment names its expression. */
    segments: z
      .array(z.union([z.string(), z.object({ var: expression }).strict()]))
      .min(2)
      .max(50),
    variables: z.record(expression, rule),
    // `variable` is reserved for query VALUES that may vary. Nothing can populate
    // it yet; it is part of the shape now so that adding it later cannot move
    // the digest of a grant made against this version.
    query: z
      .object({ fixed: z.record(z.string(), z.string()), variable: z.array(z.string()).max(0) })
      .strict(),
    max_body_bytes: z.number().int().min(0).max(10_000_000),
    max_calls: z.number().int().min(1).max(10_000),
    destructive: z.literal(true).optional(),
  })
  .strict()
  .refine((boundary) => boundary.method !== "DELETE" || boundary.destructive === true, {
    message: "a DELETE request boundary requires destructive: true",
  });
export type RequestBoundary = z.infer<typeof RequestBoundarySchema>;

/**
 * Why a step compiled no boundary. Structural reasons come first, so a step
 * this slice cannot cover is never told to "add a boundary".
 */
export type RequestBoundaryRefusal =
  | "not_http_step"
  | "pagination_unsupported"
  | "query_placeholder_unsupported"
  | "runtime_header"
  | "runtime_value_outside_path_and_body"
  | "path_unsupported"
  | "partial_segment_placeholder"
  | "no_boundary"
  | "boundary_invalid"
  | "variables_mismatch"
  | "delete_requires_destructive"
  | "target_unresolved"
  | "variable_in_base_prefix"
  | "enum_value_unroutable"
  // Raised by effect resolution, which has the connector in hand:
  | "connector_adds_query"
  | "stricter_profile_applies";

const MASK = "__subkit_var_";
const WHOLE_SEGMENT = /^\$\{([^}]+)\}$/;

function refuse(refusal: RequestBoundaryRefusal) {
  return { refusal } as const;
}

/** The authored path split into literal segments and whole-segment expressions. */
function authoredSegments(
  path: string,
):
  | { segments: Array<string | { var: string }>; refusal?: never }
  | { refusal: RequestBoundaryRefusal } {
  if (/[?#%\\]/.test(path) || path.includes(MASK)) return refuse("path_unsupported");
  const segments: Array<string | { var: string }> = [];
  for (const part of path.split("/")) {
    const whole = WHOLE_SEGMENT.exec(part);
    if (whole?.[1] !== undefined) {
      if (!expression.safeParse(whole[1]).success) return refuse("partial_segment_placeholder");
      segments.push({ var: whole[1] });
    } else if (part.includes("${")) return refuse("partial_segment_placeholder");
    else segments.push(part);
  }
  return { segments };
}

export function compileRequestBoundary(
  step: RequestStep,
  base_url: string | null,
):
  | { boundary: RequestBoundary; refusal?: never }
  | { boundary?: never; refusal: RequestBoundaryRefusal } {
  if (step.s3 || step.sql || step.mcp || step.graphql || step.xml || step.multipart)
    return refuse("not_http_step");
  if (step.pagination) return refuse("pagination_unsupported");
  if (hasRuntimeValue(step.query)) return refuse("query_placeholder_unsupported");
  if (hasRuntimeValue(step.headers)) return refuse("runtime_header");
  const { body: _body, path: _path, url: _url, query: _query, headers: _headers, ...fixed } = step;
  if (hasRuntimeValue(fixed)) return refuse("runtime_value_outside_path_and_body");
  const authored = step.path ?? step.url;
  if (!authored || (step.path !== undefined && step.url !== undefined))
    return refuse("path_unsupported");
  const split = authoredSegments(authored);
  if (split.refusal) return refuse(split.refusal);

  if (!step.boundary) return refuse("no_boundary");
  const scope = RequestBoundaryScopeSchema.safeParse(step.boundary);
  if (!scope.success) return refuse("boundary_invalid");
  // Exact coverage, both directions: a path placeholder with no rule is
  // unbounded, and a rule with no placeholder is a stale statement the
  // reviewer would be approving for nothing.
  const used = split.segments.flatMap((part) => (typeof part === "string" ? [] : [part.var]));
  const declared = Object.keys(scope.data.variables);
  if (
    new Set(used).size !== used.length ||
    used.length !== declared.length ||
    used.some((name) => !declared.includes(name))
  )
    return refuse("variables_mismatch");
  const method = (step.method ?? "GET").toUpperCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method)) return refuse("not_http_step");
  if (method === "DELETE" && scope.data.destructive !== true)
    return refuse("delete_requires_destructive");

  // Resolve through the dispatcher's own resolver, with each variable segment
  // replaced by a token made of unreserved characters so it survives `new URL`.
  const masked = split.segments
    .map((part, index) => (typeof part === "string" ? part : `${MASK}${index}__`))
    .join("/");
  let resolved: URL;
  try {
    resolved = resolveUrl(base_url, masked);
  } catch {
    return refuse("target_unresolved");
  }
  if (
    !["http:", "https:"].includes(resolved.protocol) ||
    resolved.username ||
    resolved.password ||
    resolved.hash ||
    resolved.search ||
    resolved.host.includes(MASK)
  )
    return refuse("target_unresolved");
  // `resolveUrl` strips a base-path prefix the author repeated. That decision
  // must depend on literals only, identically at review and dispatch — so no
  // variable may sit inside the part of the path the dedupe looks at.
  if (base_url) {
    try {
      const baseDepth = new URL(base_url).pathname.split("/").filter(Boolean).length;
      const leading = split.segments.filter((part) => part !== "").slice(0, baseDepth);
      if (leading.some((part) => typeof part !== "string"))
        return refuse("variable_in_base_prefix");
    } catch {
      return refuse("target_unresolved");
    }
  }
  const byToken = new Map<string, string>(
    split.segments.flatMap(
      (part, index): Array<[string, string]> =>
        typeof part === "string" ? [] : [[`${MASK}${index}__`, part.var]],
    ),
  );
  const segments = resolved.pathname.split("/").map((part) => {
    const name = byToken.get(part);
    return name === undefined ? part : { var: name };
  });
  if (segments.some((part) => typeof part === "string" && part.includes(MASK)))
    return refuse("target_unresolved");

  const candidate = RequestBoundarySchema.safeParse({
    base_url,
    method,
    origin: resolved.origin,
    segments,
    variables: scope.data.variables,
    query: {
      fixed: Object.fromEntries(
        Object.entries(step.query ?? {}).map(([key, value]) => [key, String(value)]),
      ),
      variable: [],
    },
    max_body_bytes: scope.data.max_body_bytes,
    max_calls: scope.data.max_calls,
    ...(scope.data.destructive ? { destructive: true as const } : {}),
  });
  if (!candidate.success) return refuse("boundary_invalid");

  // Every approved value must actually route inside the boundary it produced.
  // Uses the dispatch-time matcher, so a value that review accepts and dispatch
  // would deny is caught here, where the author can still fix it.
  for (const name of declared) {
    for (const value of scope.data.variables[name]?.enum ?? []) {
      const concrete = split.segments
        .map((part) =>
          typeof part === "string"
            ? part
            : part.var === name
              ? value
              : (scope.data.variables[part.var]?.enum[0] ?? ""),
        )
        .join("/");
      try {
        if (!matchTarget(candidate.data, resolveUrl(base_url, concrete)))
          return refuse("enum_value_unroutable");
      } catch {
        return refuse("enum_value_unroutable");
      }
    }
  }
  return { boundary: candidate.data };
}

export function requestBoundary(
  step: RequestStep,
  base_url: string | null,
): RequestBoundary | null {
  return compileRequestBoundary(step, base_url).boundary ?? null;
}

/** What the reviewer is shown: the resolved target with each variable named. */
export function requestBoundaryTarget(boundary: RequestBoundary): string {
  return `${boundary.origin}${boundary.segments
    .map((part) => (typeof part === "string" ? part : `{${part.var}}`))
    .join("/")}`;
}

/** The one place a concrete segment is judged against its rule. */
function validateSegment(variableRule: RequestVariableRule | undefined, raw: string): boolean {
  return variableRule?.enum.includes(raw) === true;
}

/** Origin and path only. Shared by the review-time self-check and dispatch. */
function matchTarget(boundary: RequestBoundary, url: URL): boolean {
  if (url.origin !== boundary.origin || url.username || url.password || url.hash) return false;
  // RAW pathname segments: never decoded, so an encoded traversal is simply not
  // equal to an approved literal.
  const actual = url.pathname.split("/");
  if (actual.length !== boundary.segments.length) return false;
  return boundary.segments.every((expected, index) => {
    const raw = actual[index] ?? "";
    return typeof expected === "string"
      ? raw === expected
      : validateSegment(boundary.variables[expected.var], raw);
  });
}

/** Why a materialized request is outside a boundary. Carries sizes, never content. */
export type RequestBoundaryViolation =
  | { kind: "boundary_invalid" | "request_missing" | "unsupported_body" | "url_invalid" }
  | { kind: "method"; actual: string; reviewed: string }
  | { kind: "target"; reviewed: string }
  | { kind: "query" }
  | { kind: "body_forbidden"; method: string }
  | { kind: "body_size"; bytes: number; max_body_bytes: number };

/**
 * The one judgement of a request against a boundary. Dispatch under an
 * authority denies on any violation; a run of a step that merely DECLARES a
 * boundary reports the same violation by name, so a green preview means the
 * request fits the boundary its step asks a human to approve.
 */
export function requestBoundaryViolation(
  boundary: RequestBoundary,
  request: MaterializedRequest | undefined,
): RequestBoundaryViolation | null {
  const parsed = RequestBoundarySchema.safeParse(boundary);
  if (!parsed.success) return { kind: "boundary_invalid" };
  if (!request) return { kind: "request_missing" };
  // A body the assert cannot measure (multipart, a file) is denied, never skipped.
  if (request.unsupported_body) return { kind: "unsupported_body" };
  const reviewed = parsed.data;
  const method = request.method.toUpperCase();
  if (method !== reviewed.method)
    return { kind: "method", actual: method, reviewed: reviewed.method };
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { kind: "url_invalid" };
  }
  if (!matchTarget(reviewed, url))
    return { kind: "target", reviewed: requestBoundaryTarget(reviewed) };
  if (reviewed.query.variable.length > 0) return { kind: "query" };
  const keys = [...url.searchParams.keys()];
  const fixedKeys = Object.keys(reviewed.query.fixed);
  if (
    new Set(keys).size !== keys.length ||
    keys.length !== fixedKeys.length ||
    fixedKeys.some((key) => url.searchParams.get(key) !== reviewed.query.fixed[key])
  )
    return { kind: "query" };
  if (reviewed.method === "GET" || reviewed.method === "HEAD")
    return request.body !== null && request.body !== undefined
      ? { kind: "body_forbidden", method: reviewed.method }
      : null;
  if (request.body === null || request.body === undefined) return null;
  // Plain JSON.stringify, not the canonicaliser: this is the driver's own wire
  // encoding, and key sorting would change the byte count against the wire.
  const wire = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
  if (wire === undefined) return { kind: "unsupported_body" };
  const bytes = Buffer.byteLength(wire, "utf8");
  return bytes > reviewed.max_body_bytes
    ? { kind: "body_size", bytes, max_body_bytes: reviewed.max_body_bytes }
    : null;
}

/** One sentence an author can act on. Names sizes and the reviewed target, never content. */
export function describeRequestBoundaryViolation(violation: RequestBoundaryViolation): string {
  switch (violation.kind) {
    case "body_size":
      return `the body is ${violation.bytes} bytes but \`boundary.max_body_bytes\` is ${violation.max_body_bytes}`;
    case "target":
      return `the resolved URL is not ${violation.reviewed} with an approved value for every variable`;
    case "method":
      return `the method is ${violation.actual} but the boundary was compiled for ${violation.reviewed}`;
    case "query":
      return "the query parameters differ from the step's static `query`";
    case "body_forbidden":
      return `a ${violation.method} request under a boundary may not carry a body`;
    case "unsupported_body":
      return "the body cannot be measured (multipart or file)";
    default:
      return "the request could not be compared with the boundary";
  }
}

export function assertRequestBoundary(
  boundary: RequestBoundary,
  request: MaterializedRequest | undefined,
): void {
  if (requestBoundaryViolation(boundary, request) !== null)
    throw Object.assign(
      new Error("Request differs from its reviewed target, method or size boundary"),
      { code: "execution_authority_changed" },
    );
}
