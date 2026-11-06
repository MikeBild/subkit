import { classifyHttpSideEffect, type SideEffect } from "@shared/index.ts";
import { resolveGraphqlStepEndpoint } from "../../../connectors/drivers/graphql-endpoint.ts";
import { scrubString, scrubStringsDeep } from "../../../logging/scrub-secrets.ts";
import { now } from "../../../utils/clock.ts";
import type { RequestStep } from "../../../workflows/types.ts";
import type { Clock } from "../../clock.ts";
import type { HeldRequest, RequestMeta, StepResult } from "../../types.ts";
import { SAFE_HEADER_DENYLIST } from "../error-detail.ts";

type StepSideEffects = SideEffect;

export function requestRequiresPreparationHold(
  step: RequestStep,
  driver?: string,
  baseUrl?: string | null,
): boolean {
  const declaredDriver = step.mcp
    ? "mcp"
    : step.sql
      ? "postgres"
      : step.graphql
        ? "graphql"
        : step.s3
          ? "s3"
          : "http";
  const graphqlOnHttp =
    declaredDriver === "graphql" &&
    driver === "http" &&
    resolveGraphqlStepEndpoint({ driver, base_url: baseUrl, path: step.path, url: step.url }).ok;
  if (driver !== undefined && driver !== declaredDriver && !graphqlOnHttp) return true;
  if (step.sql || driver === "postgres") return true;
  return (
    classifyRequestStepSideEffects(
      {
        ...step,
        side_effects: step.side_effects === "write" ? "write" : undefined,
      },
      driver,
      undefined,
      baseUrl,
    ) === "write"
  );
}

export function classifyRequestStepSideEffects(
  step: RequestStep,
  driver?: string,
  method?: string,
  baseUrl?: string | null,
): StepSideEffects {
  return classifyHttpSideEffect({
    override: step.side_effects ?? null,
    method: method ?? step.method ?? null,
    graphql: step.graphql
      ? { operation: step.graphql.operation ?? null, query: step.graphql.query }
      : null,
    sql: step.sql
      ? { query: step.sql.query, ...(step.sql.also ? { also: step.sql.also } : {}) }
      : null,
    s3: Boolean(step.s3) || driver === "s3",
    mcp: step.mcp ? { operation: step.mcp.operation } : null,
    target: step.url ?? step.path ?? null,
    body: step.body,
    baseUrl: baseUrl ?? null,
  });
}

const REDACTED_HEADER_MARKER = "***REDACTED:auth_header***";

export function redactHeldRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SAFE_HEADER_DENYLIST.has(k.toLowerCase()) ? REDACTED_HEADER_MARKER : scrubString(v);
  }
  return out;
}

export interface HeldStepResultParams {
  start: number;
  clock?: Clock;
  method: string;
  url: string | null;
  headers?: Record<string, string>;
  body: unknown;
  request_meta?: RequestMeta;
}

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
    duration_ms: (p.clock?.now() ?? now()) - p.start,
    ...(p.request_meta ? { request_meta: p.request_meta } : {}),
  };
}
