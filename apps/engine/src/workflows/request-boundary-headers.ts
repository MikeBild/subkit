import { z } from "@hono/zod-openapi";
import { onlyVaultHandles } from "./core/vault-uses.ts";
import { hasRuntimeValue } from "./report-delivery-boundary.ts";
import {
  expression,
  headerRule,
  type RequestHeaderRule,
  valueAllowed,
  wholeValueExpression,
} from "./request-value-rules.ts";
import type { RequestStep } from "./types.ts";

const MAX_BOUNDED_HEADERS = 20;
const IDEMPOTENCY_HEADER = "idempotency-key";

const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/);

const distinctNames = (record: Record<string, unknown>) => {
  const names = Object.keys(record).map((name) => name.toLowerCase());
  return names.length <= MAX_BOUNDED_HEADERS && new Set(names).size === names.length;
};

export const RequestHeaderBoundsSchema = z
  .record(headerName, headerRule)
  .refine(distinctNames, {
    message: `at most ${MAX_BOUNDED_HEADERS} header names, each listed once regardless of case`,
  })
  .describe(
    "Header values that may vary at run time, keyed by the literal header name. Each value is one whole `${input.*}`, `${scope.*}` or `${item.*}` placeholder and its resolved value must meet the rule: an `enum` or a value `class` as in `variables`.",
  );

export const ReviewedHeadersSchema = z
  .record(headerName, z.object({ var: expression, rule: headerRule }).strict())
  .refine(distinctNames);
export type ReviewedHeaders = z.infer<typeof ReviewedHeadersSchema>;

export type HeaderBoundaryRefusal = "runtime_header" | "header_boundary_mismatch";

type BoundedHeaders =
  | { idempotency_key?: { var: string }; headers?: ReviewedHeaders; refusal?: never }
  | { refusal: HeaderBoundaryRefusal };

const refuse = (refusal: HeaderBoundaryRefusal) => ({ refusal }) as const;

function effectiveHeaders(step: RequestStep): Record<string, string> {
  const ownsIdempotency = Object.keys(step.headers ?? {}).some(
    (name) => name.toLowerCase() === IDEMPOTENCY_HEADER,
  );
  return step.idempotency_key !== undefined && !ownsIdempotency
    ? { ...step.headers, "Idempotency-Key": step.idempotency_key }
    : { ...step.headers };
}

export function boundedRequestHeaders(
  step: RequestStep,
  bounds: Record<string, RequestHeaderRule> | undefined,
): BoundedHeaders {
  const declared = new Map(
    Object.entries(bounds ?? {}).map(([name, rule]) => [name.toLowerCase(), { name, rule }]),
  );
  const headers: ReviewedHeaders = {};
  let idempotencyKey: { var: string } | undefined;
  const sent = effectiveHeaders(step);
  for (const [name, value] of Object.entries(sent)) {
    if (hasRuntimeValue(name)) return refuse("runtime_header");
    const runtime = hasRuntimeValue(value) && !onlyVaultHandles(value);
    const variable = runtime ? wholeValueExpression(value) : null;
    const bound = declared.get(name.toLowerCase());
    if (bound) {
      if (!runtime || bound.name in headers) return refuse("header_boundary_mismatch");
      if (!variable) return refuse("runtime_header");
      headers[bound.name] = { var: variable, rule: bound.rule };
      continue;
    }
    if (!runtime) continue;
    if (name.toLowerCase() !== IDEMPOTENCY_HEADER || idempotencyKey || !variable)
      return refuse("runtime_header");
    idempotencyKey = { var: variable };
  }
  if (Object.keys(headers).length !== declared.size) return refuse("header_boundary_mismatch");
  if (
    idempotencyKey &&
    Object.keys(sent).filter((name) => name.toLowerCase() === IDEMPOTENCY_HEADER).length !== 1
  )
    return refuse("runtime_header");
  return {
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    ...(declared.size > 0 ? { headers } : {}),
  };
}

export function reviewedHeaderViolation(
  reviewed: ReviewedHeaders | undefined,
  sent: Record<string, string>,
): string | null {
  for (const [name, entry] of Object.entries(reviewed ?? {})) {
    const values = Object.entries(sent)
      .filter(([sentName]) => sentName.toLowerCase() === name.toLowerCase())
      .map(([, value]) => value);
    if (values.length !== 1 || !valueAllowed(entry.rule, values[0] ?? "")) return name;
  }
  return null;
}
