// Side-effect classification for request-class steps (Fix G) plus the
// held-result builder the dispatch branches use in hold-writes mode.
//
// Classification lives at the layer that owns the knowledge — the
// driver semantics — never vendor keywords:
//
//   - explicit `step.side_effects` override ALWAYS wins (the author's
//     escape hatch for a POST that is semantically a search, or a GET
//     that mutates)
//   - GraphQL: `query` operations = read; `mutation` / `subscription`
//     = write. The operation comes from the step's explicit
//     `graphql.operation` or is inferred from the document's leading
//     keyword (a bare `{ … }` shorthand document is a query per the
//     GraphQL spec).
//   - SQL (postgres): SELECT-only statements = read (including every
//     statement in `sql.also`); anything else = write.
//   - S3: GET / HEAD / LIST = read; PUT / DELETE = write.
//   - HTTP: the existing `isIdempotent` retry seam — GET / HEAD /
//     OPTIONS = read; every other method = write (RFC semantics).
//
// Transforms / branches / loops / waits are never classified — only
// request steps dispatch externally.

import { scrubString, scrubStringsDeep } from "../../../logging/scrub-secrets.ts";
import type { RequestStep } from "../../../workflows/types.ts";
import type { HeldRequest, RequestMeta, StepResult } from "../../types.ts";
import { SAFE_HEADER_DENYLIST } from "../error-detail.ts";
import { isIdempotent } from "./retry.ts";

export type StepSideEffects = "read" | "write";

const S3_READ_METHODS = new Set(["GET", "HEAD", "LIST"]);

/** Leading-keyword GraphQL operation inference. Strips leading
 *  whitespace and `#` comments; a document that opens with the bare
 *  selection-set shorthand `{` is a query by spec. Exotic documents
 *  (fragment-first) fall back to "query" — authors cover those with
 *  the explicit `graphql.operation` or `side_effects` override. */
function inferGraphqlOperation(query: string): "query" | "mutation" | "subscription" {
  const stripped = query.replace(/^(?:\s+|#[^\n]*\n?)+/, "");
  const m = /^(query|mutation|subscription)\b/i.exec(stripped);
  if (m) return m[1]!.toLowerCase() as "query" | "mutation" | "subscription";
  return "query";
}

// True when the statement (after leading whitespace, `--` line comments
// and block comments) starts with SELECT. WITH-CTEs and everything else
// classify as write — conservative by design; `side_effects: "read"`
// overrides when the author knows better.
function sqlIsSelect(query: string): boolean {
  let s = query;
  for (;;) {
    const next = s
      .replace(/^\s+/, "")
      .replace(/^--[^\n]*\n?/, "")
      .replace(/^\/\*[\s\S]*?\*\//, "");
    if (next === s) break;
    s = next;
  }
  return /^select\b/i.test(s);
}

export function classifyRequestStepSideEffects(step: RequestStep): StepSideEffects {
  if (step.side_effects) return step.side_effects;
  if (step.graphql) {
    const op = step.graphql.operation ?? inferGraphqlOperation(step.graphql.query);
    return op === "query" ? "read" : "write";
  }
  if (step.sql) {
    const statements = [step.sql.query, ...(step.sql.also ?? []).map((s) => s.query)];
    return statements.every(sqlIsSelect) ? "read" : "write";
  }
  const method = (step.method ?? "GET").toUpperCase();
  if (step.s3) {
    return S3_READ_METHODS.has(method) ? "read" : "write";
  }
  return isIdempotent(method) ? "read" : "write";
}

const REDACTED_HEADER_MARKER = "***REDACTED:auth_header***";

/** Redact a fully-materialized header map for the `held_request`
 *  artifact. Every header NAME survives (the judge must see that an
 *  Authorization header WILL be sent); values on the shared
 *  auth-header denylist are masked outright, and every remaining value
 *  runs through the shared secret scrubber so a token in a custom
 *  vendor header cannot leak either. */
export function redactHeldRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SAFE_HEADER_DENYLIST.has(k.toLowerCase()) ? REDACTED_HEADER_MARKER : scrubString(v);
  }
  return out;
}

export interface HeldStepResultParams {
  /** `Date.now()` captured at step start — for duration accounting. */
  start: number;
  method: string;
  url: string | null;
  /** Materialized request headers (credentials already applied where
   *  the driver path applies them pre-dispatch). Redacted here. */
  headers?: Record<string, string>;
  /** Resolved request payload. Structure and prose survive verbatim
   *  (the judge reads the would-be email HTML); only SECRET-SHAPED
   *  substrings are masked — the held body persists in draft state and
   *  re-renders into the LLM context every turn, so a forwarded token
   *  inside a templated payload field must not ride along clear. */
  body: unknown;
  request_meta?: RequestMeta;
}

/** The step outcome for a write held in hold-writes mode: succeeded,
 *  `held: true`, `output: null`, zero retries — and the materialized
 *  request as the artifact. See `HeldRequest` in execution/types.ts
 *  for the representation contract. */
export function heldStepResult(p: HeldStepResultParams): StepResult {
  const held_request: HeldRequest = {
    method: p.method,
    url: p.url,
    headers_redacted: redactHeldRequestHeaders(p.headers ?? {}),
    body: p.body === undefined || p.body === null ? null : scrubStringsDeep(p.body),
  };
  return {
    status: "succeeded",
    held: true,
    held_request,
    output: null,
    retry_count: 0,
    duration_ms: Date.now() - p.start,
    ...(p.request_meta ? { request_meta: p.request_meta } : {}),
  };
}
