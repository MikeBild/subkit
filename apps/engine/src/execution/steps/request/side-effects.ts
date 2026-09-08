// Side-effect classification for request-class steps (Fix G) plus the
// held-result builder the dispatch branches use in hold-writes mode.
//
// The classification rules themselves live in the shared, pure
// `classifyHttpSideEffect` (packages/shared/src/side-effects.ts) so the
// retry classifier adapts a `RequestStep` onto that primitive. Preparation
// adds a stricter boundary below: an author's read hint is not permission
// to send a POST, and a lexical SELECT is not proof of harmless SQL.
//
// Transforms / branches / loops / waits are never classified — only
// request steps dispatch externally.

import { classifyHttpSideEffect, type SideEffect } from "@shared/index.ts";
import { scrubString, scrubStringsDeep } from "../../../logging/scrub-secrets.ts";
import type { RequestStep } from "../../../workflows/types.ts";
import type { HeldRequest, RequestMeta, StepResult } from "../../types.ts";
import { SAFE_HEADER_DENYLIST } from "../error-detail.ts";

export type StepSideEffects = SideEffect;

/** Preparation is not an execution grant. Retry hints may describe a search
 * POST or lexical SELECT, but neither proves that an unapproved call is inert.
 * Recheck against the resolved driver so a legacy/mismatched definition cannot
 * borrow HTTP read semantics for another transport. */
export function requestRequiresPreparationHold(step: RequestStep, driver?: string): boolean {
  const declaredDriver = step.mcp
    ? "mcp"
    : step.sql
      ? "postgres"
      : step.graphql
        ? "graphql"
        : step.s3
          ? "s3"
          : "http";
  if (driver !== undefined && driver !== declaredDriver) return true;
  if (step.sql || driver === "postgres") return true;
  return (
    classifyRequestStepSideEffects({
      ...step,
      side_effects: step.side_effects === "write" ? "write" : undefined,
    }) === "write"
  );
}

export function classifyRequestStepSideEffects(step: RequestStep): StepSideEffects {
  return classifyHttpSideEffect({
    override: step.side_effects ?? null,
    method: step.method ?? null,
    graphql: step.graphql
      ? { operation: step.graphql.operation ?? null, query: step.graphql.query }
      : null,
    sql: step.sql
      ? { query: step.sql.query, ...(step.sql.also ? { also: step.sql.also } : {}) }
      : null,
    s3: Boolean(step.s3),
    mcp: step.mcp ? { operation: step.mcp.operation } : null,
  });
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
