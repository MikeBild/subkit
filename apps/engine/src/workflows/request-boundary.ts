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
// What may vary: whole path segments and whole query VALUES, each bound by an
// explicit `enum` or, where values cannot be listed (an id from an earlier step,
// a date), by a named value class; plus a runtime body bounded by size. Anything
// it cannot hold to a reviewed statement is REFUSED with a named reason rather
// than accepted loosely — a runtime header, a placeholder that is only part of
// a segment or of a query value, a query KEY that varies, pagination.

import { z } from "@hono/zod-openapi";
import { resolveUrl } from "../connectors/drivers/resolve-url.ts";
import type { MaterializedRequest } from "../execution/prepared-request.ts";
import { hasRuntimeValue } from "./report-delivery-boundary.ts";
import type { RequestStep } from "./types.ts";

/** A placeholder expression without its `${}`: `input.site`, `item.id`, `scope.plan.data.id`. */
const expression = z.string().regex(/^(?:item|input|scope)(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/);
// A record reports a bad key as a bare "Invalid key in record", which sent an
// author guessing: it keyed a rule by the query parameter's NAME.
const VARIABLES_KEY_ERROR =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shows the literal authored placeholder
  "a `variables` key is the placeholder expression without its `${}`, rooted at `input`, " +
  "`scope` or `item` — for example `scope.window.data.start` or `item.id`. A query " +
  "parameter's name or a path segment's label is not a key.";
const variablesError = (issue: { code?: string }) =>
  issue.code === "invalid_key" ? VARIABLES_KEY_ERROR : undefined;

/**
 * A value an approved variable may take, exactly as it is sent: unreserved URL
 * characters, `:` (a segment such as `team:42` or `123:runReport`), and
 * `%XX` escapes for an identifier the API wants percent-encoded inside one
 * segment. Compared byte for byte against the raw segment, never decoded for
 * the comparison, so what the reviewer reads is what may be sent.
 *
 * It can still never leave its segment: a literal `/`, `?` or `#` is not in the
 * alphabet, an escape that decodes to a control character or a backslash is
 * refused, and so is a value whose decoded form has a `.` or `..` component —
 * a server that decodes before routing must not be handed a traversal. A value
 * that routes differently than reviewed (a leading `scheme:`) fails the
 * review-time self-check below.
 */
const enumValue = z
  .string()
  .regex(/^(?:[A-Za-z0-9._~:-]|%[0-9A-Fa-f]{2}){1,200}$/)
  .refine((value) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return false;
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
    if (/[\u0000-\u001f\u007f\\]/.test(decoded)) return false;
    return !decoded.split("/").some((part) => part === "." || part === "..");
  });
/**
 * For values that cannot be listed. Pinned regex literals, deliberately not Zod
 * helpers: a library upgrade must never change what a live approval means. No
 * class admits `%`, `/`, `?`, `#` or whitespace, so a raw path segment and its
 * decoded form are the same string and no decode step exists to disagree on.
 */
export const VALUE_CLASSES = {
  identifier: /^[A-Za-z0-9_-]{1,200}$/,
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/,
  integer: /^(0|[1-9][0-9]{0,18})$/,
  date: /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/,
  timestamp: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/,
} as const;
type ValueClass = keyof typeof VALUE_CLASSES;
const VALUE_CLASS_NAMES = Object.keys(VALUE_CLASSES) as [ValueClass, ...ValueClass[]];
/** A worst-case member of each class, for the review-time routing self-check. */
const CLASS_SAMPLE: Record<ValueClass, string> = {
  identifier: "a",
  uuid: "00000000-0000-4000-8000-000000000000",
  integer: "0",
  date: "2000-01-01",
  timestamp: "2000-01-01T00:00:00Z",
};

// The `enum` branch stays FIRST: a boundary written before classes existed
// must parse to the byte-identical object, or its approval's digest moves.
const rule = z.union([
  z.object({ enum: z.array(enumValue).min(1).max(50) }).strict(),
  z.object({ class: z.enum(VALUE_CLASS_NAMES) }).strict(),
]);
export type RequestVariableRule = z.infer<typeof rule>;

export const RequestBoundaryScopeSchema = z
  .object({
    /**
     * One entry per `${…}` that is a whole path segment or a whole query value,
     * keyed by the expression. `{}` when neither varies.
     */
    variables: z.record(expression, rule, { error: variablesError }),
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
    variables: z.record(expression, rule, { error: variablesError }),
    // The key set is exact: `fixed` keys carry a literal value, `variable` keys
    // a value held to its rule. The array is always present, `[]` when nothing
    // varies, so a boundary approved before query values could vary keeps its
    // digest.
    query: z
      .object({
        fixed: z.record(z.string(), z.string()),
        variable: z.array(z.object({ key: z.string().min(1), var: expression }).strict()).max(50),
      })
      .strict(),
    max_body_bytes: z.number().int().min(0).max(10_000_000),
    max_calls: z.number().int().min(1).max(10_000),
    destructive: z.literal(true).optional(),
  })
  .strict()
  .refine((boundary) => boundary.method !== "DELETE" || boundary.destructive === true, {
    message: "a DELETE request boundary requires destructive: true",
  })
  // "Delete anything that looks like an id" is not a statement to approve.
  .refine(
    (boundary) =>
      boundary.method !== "DELETE" ||
      Object.values(boundary.variables).every((entry) => "enum" in entry),
    { message: "a DELETE request boundary may only vary over listed values" },
  );
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
  | "delete_requires_enum"
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
  // A query value may vary only as a WHOLE placeholder; text around one, or a
  // non-scalar value, cannot be held to a rule.
  const fixedQuery: Record<string, string> = {};
  const variableQuery: Array<{ key: string; var: string }> = [];
  for (const [key, value] of Object.entries(step.query ?? {})) {
    const whole = typeof value === "string" ? WHOLE_SEGMENT.exec(value) : null;
    if (whole?.[1] !== undefined && expression.safeParse(whole[1]).success)
      variableQuery.push({ key, var: whole[1] });
    else if (hasRuntimeValue(value) || hasRuntimeValue(key))
      return refuse("query_placeholder_unsupported");
    else fixedQuery[key] = String(value);
  }
  variableQuery.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (hasRuntimeValue(step.headers)) return refuse("runtime_header");
  const {
    body: _body,
    path: _path,
    url: _url,
    query: _query,
    headers: _headers,
    // `for_each` and `data_selector` carry JavaScript the sandbox evaluates;
    // the engine never substitutes placeholders into them. A `${…}` inside one
    // is a JS template literal, and scanning them for it refused a correct step
    // with "make every other field a literal" — impossible for a selector.
    // Neither can move the target: `for_each` decides how many requests and
    // what `item.*` holds (both bounded here), `data_selector` shapes output.
    for_each: _forEach,
    data_selector: _dataSelector,
    ...fixed
  } = step;
  if (hasRuntimeValue(fixed)) return refuse("runtime_value_outside_path_and_body");
  const authored = step.path ?? step.url;
  if (!authored || (step.path !== undefined && step.url !== undefined))
    return refuse("path_unsupported");
  const split = authoredSegments(authored);
  if (split.refusal) return refuse(split.refusal);

  if (!step.boundary) return refuse("no_boundary");
  const scope = RequestBoundaryScopeSchema.safeParse(step.boundary);
  if (!scope.success) return refuse("boundary_invalid");
  // Exact coverage, both directions: a placeholder with no rule is unbounded,
  // and a rule with no placeholder is a stale statement the reviewer would be
  // approving for nothing. One expression, one position.
  const used = [
    ...split.segments.flatMap((part) => (typeof part === "string" ? [] : [part.var])),
    ...variableQuery.map((entry) => entry.var),
  ];
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
  if (
    method === "DELETE" &&
    Object.values(scope.data.variables).some((entry) => !("enum" in entry))
  )
    return refuse("delete_requires_enum");

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
    query: { fixed: fixedQuery, variable: variableQuery },
    max_body_bytes: scope.data.max_body_bytes,
    max_calls: scope.data.max_calls,
    ...(scope.data.destructive ? { destructive: true as const } : {}),
  });
  if (!candidate.success) return refuse("boundary_invalid");

  // Every approved value must actually route inside the boundary it produced.
  // Uses the dispatch-time judgement on a URL assembled the way the driver
  // assembles it, so a value that review accepts and dispatch would deny is
  // caught here, where the author can still fix it. A class is tried with one
  // worst-case member.
  const samples = (name: string): string[] => {
    const entry = scope.data.variables[name];
    if (!entry) return [""];
    return "enum" in entry ? entry.enum : [CLASS_SAMPLE[entry.class]];
  };
  for (const name of declared) {
    for (const value of samples(name)) {
      const pick = (other: string) => (other === name ? value : (samples(other)[0] ?? ""));
      const concrete = split.segments
        .map((part) => (typeof part === "string" ? part : pick(part.var)))
        .join("/");
      try {
        const url = resolveUrl(base_url, concrete);
        for (const [key, fixed] of Object.entries(fixedQuery)) url.searchParams.set(key, fixed);
        for (const entry of variableQuery) url.searchParams.set(entry.key, pick(entry.var));
        if (!matchTarget(candidate.data, url) || !matchQuery(candidate.data, url))
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

/**
 * The one place a concrete value is judged against its rule: a raw path segment
 * or a decoded query value, which is in both cases exactly the string the
 * placeholder resolved to.
 */
function valueAllowed(variableRule: RequestVariableRule | undefined, value: string): boolean {
  if (!variableRule) return false;
  if ("enum" in variableRule) return variableRule.enum.includes(value);
  return VALUE_CLASSES[variableRule.class]?.test(value) === true;
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
      : valueAllowed(boundary.variables[expected.var], raw);
  });
}

/**
 * What is wrong with a query, in terms an author can act on. A VALUE is named
 * only for a declared variable — that is workflow data. An unexpected key is
 * named without its value, which a connector may have filled with a credential.
 */
export type RequestQueryViolation =
  | { reason: "unexpected_key" | "missing_key" | "duplicate_key" | "fixed_value"; key: string }
  | { reason: "variable_value"; key: string; value: string; rule: string };

/** The query part of the same judgement: an exact key set, never a superset. */
function queryViolation(boundary: RequestBoundary, url: URL): RequestQueryViolation | null {
  const keys = [...url.searchParams.keys()];
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate !== undefined) return { reason: "duplicate_key", key: duplicate };
  const fixedKeys = Object.keys(boundary.query.fixed);
  const reviewed = new Set([...fixedKeys, ...boundary.query.variable.map((entry) => entry.key)]);
  const unexpected = keys.find((key) => !reviewed.has(key));
  if (unexpected !== undefined) return { reason: "unexpected_key", key: unexpected };
  const missing = [...reviewed].find((key) => !url.searchParams.has(key));
  if (missing !== undefined) return { reason: "missing_key", key: missing };
  const changed = fixedKeys.find((key) => url.searchParams.get(key) !== boundary.query.fixed[key]);
  if (changed !== undefined) return { reason: "fixed_value", key: changed };
  for (const entry of boundary.query.variable) {
    const value = url.searchParams.get(entry.key) ?? "";
    const variableRule = boundary.variables[entry.var];
    if (!valueAllowed(variableRule, value))
      return {
        reason: "variable_value",
        key: entry.key,
        value: value.slice(0, 100),
        rule: !variableRule
          ? "no rule"
          : "enum" in variableRule
            ? `enum of ${variableRule.enum.length} value(s)`
            : `class ${variableRule.class}`,
      };
  }
  return null;
}
function matchQuery(boundary: RequestBoundary, url: URL): boolean {
  return queryViolation(boundary, url) === null;
}

/** Why a materialized request is outside a boundary. Carries sizes, never content. */
export type RequestBoundaryViolation =
  | { kind: "boundary_invalid" | "request_missing" | "unsupported_body" | "url_invalid" }
  | { kind: "method"; actual: string; reviewed: string }
  | { kind: "target"; reviewed: string; actual: string }
  | { kind: "query"; detail: RequestQueryViolation }
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
  // Origin and path only: a query could carry a credential, a path is workflow data.
  if (!matchTarget(reviewed, url))
    return {
      kind: "target",
      reviewed: requestBoundaryTarget(reviewed),
      actual: `${url.origin}${url.pathname}`.slice(0, 300),
    };
  const query = queryViolation(reviewed, url);
  if (query) return { kind: "query", detail: query };
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
      return `the resolved URL ${violation.actual} is not ${violation.reviewed} with an approved value for every variable`;
    case "method":
      return `the method is ${violation.actual} but the boundary was compiled for ${violation.reviewed}`;
    case "query": {
      const { detail } = violation;
      if (detail.reason === "variable_value")
        return `the query value \`${detail.key}\` is "${detail.value}", which is outside its rule (${detail.rule})`;
      if (detail.reason === "fixed_value")
        return `the query parameter \`${detail.key}\` no longer has the fixed value the step declares`;
      if (detail.reason === "missing_key")
        return `the query parameter \`${detail.key}\` the step declares is missing from the request`;
      if (detail.reason === "duplicate_key")
        return `the query parameter \`${detail.key}\` appears more than once`;
      return `the request carries a query parameter \`${detail.key}\` the step does not declare`;
    }
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
