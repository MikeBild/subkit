import { checkJsonSchemaContract } from "../json-schema-contract.ts";
import { isOffloadRef, type OffloadRef, OffloadResolutionError, previewOf } from "../offload.ts";
import type { RunStepOutcome } from "../step-runner.ts";
import type { HeldRequest, StepResult } from "../types.ts";

export function validateAgainstJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
  location: string,
): { valid: boolean; errors: string[] } {
  const check = checkJsonSchemaContract(value, schema, location);
  if (!check.ok) return { valid: false, errors: [`${location}: ${check.schema_error}`] };
  return check.valid
    ? { valid: true, errors: [] }
    : {
        valid: false,
        errors: check.violations.map((violation) => `${violation.path}: ${violation.message}`),
      };
}

export interface ScopeEnvelope {
  data: unknown;
  status_code?: number;
  headers?: Record<string, string>;
  duration_ms: number;
  error: { code: string; message: string; details?: unknown } | null;
  held?: true;
  held_request?: HeldRequest;
  pagination?: EnvelopePagination;
}

interface EnvelopePagination {
  pages: number;
  items: number;
  duplicates_dropped: number;
  complete: boolean;
  truncated: boolean;
}

const SCOPE_ENVELOPE_FIELD_SET = {
  data: true,
  status_code: true,
  headers: true,
  duration_ms: true,
  error: true,
  held: true,
  held_request: true,
  pagination: true,
} as const satisfies Record<keyof ScopeEnvelope, true>;
export const SCOPE_ENVELOPE_FIELDS = Object.keys(SCOPE_ENVELOPE_FIELD_SET) as Array<
  keyof ScopeEnvelope
>;

const ENVELOPE_PAGINATION_FIELD_SET = {
  pages: true,
  items: true,
  duplicates_dropped: true,
  complete: true,
  truncated: true,
} as const satisfies Record<keyof EnvelopePagination, true>;
export const ENVELOPE_PAGINATION_FIELDS = Object.keys(ENVELOPE_PAGINATION_FIELD_SET) as Array<
  keyof EnvelopePagination
>;

function envelopePagination(value: unknown): EnvelopePagination | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const { pages, items, duplicates_dropped, complete, truncated } = record;
  if (
    typeof pages !== "number" ||
    typeof items !== "number" ||
    typeof duplicates_dropped !== "number" ||
    typeof complete !== "boolean" ||
    typeof truncated !== "boolean"
  )
    return null;
  return { pages, items, duplicates_dropped, complete, truncated };
}

export function wrapEnvelope(params: {
  data: unknown;
  duration_ms: number;
  error: { code: string; message: string; details?: unknown } | null;
  request_meta?: Record<string, unknown> | null;
}): ScopeEnvelope {
  const env: ScopeEnvelope = {
    data: params.data ?? null,
    duration_ms: params.duration_ms,
    error: params.error ?? null,
  };
  const rm = params.request_meta;
  if (rm && typeof rm === "object") {
    if (typeof rm.status === "number") env.status_code = rm.status;
    if (rm.headers && typeof rm.headers === "object") {
      env.headers = rm.headers as Record<string, string>;
    }
    const pagination = envelopePagination(rm.pagination);
    if (pagination) env.pagination = pagination;
  }
  return env;
}

type BodyEnvelopeVerdict = "productive" | "offloaded" | "empty";

export function classifyBodyEnvelope(value: unknown): BodyEnvelopeVerdict {
  const env = value as ScopeEnvelope | null | undefined;
  if (!env || typeof env !== "object") return "empty";
  if (env.held) return "productive";
  if (env.error) return env.error.code === "skipped_dependency_held" ? "productive" : "empty";
  if (isOffloadRef(env.data)) return "offloaded";
  if (typeof env.status_code === "number" && env.status_code < 400) return "productive";
  const data = env.data;
  if (data == null) return "empty";
  if (Array.isArray(data) && data.length === 0) return "empty";
  if (typeof data === "object" && Object.keys(data as object).length === 0) return "empty";
  return "productive";
}

export function classifyBodyIteration(iteration: unknown): {
  productive: boolean;
  offloaded: boolean;
} {
  if (!iteration || typeof iteration !== "object") return { productive: false, offloaded: false };
  let productive = false;
  let offloaded = false;
  for (const value of Object.values(iteration as Record<string, unknown>)) {
    const verdict = classifyBodyEnvelope(value);
    if (verdict === "offloaded") offloaded = true;
    if (verdict !== "empty") productive = true;
  }
  return { productive, offloaded };
}

export function envelopeFor(outcome: { result: StepResult; scope_value: unknown }): ScopeEnvelope {
  const env = wrapEnvelope({
    data: outcome.scope_value,
    duration_ms: outcome.result.duration_ms ?? 0,
    error: outcome.result.error ?? null,
    request_meta: outcome.result.request_meta ?? null,
  });
  if (outcome.result.held) {
    env.held = true;
    if (outcome.result.held_request) env.held_request = outcome.result.held_request;
  }
  return env;
}

export function bodyEnvelopeForLoopAccumulator(outcome: RunStepOutcome): ScopeEnvelope {
  const env = envelopeFor(outcome);
  const storageUri = outcome.result_storage_uri;
  if (storageUri && outcome.scope_value != null) {
    if (typeof outcome.result_size_bytes !== "number") {
      throw new OffloadResolutionError(storageUri, "missing result_size_bytes");
    }
    const ref: OffloadRef = {
      $offloaded: true,
      storage_uri: storageUri,
      preview: outcome.result_preview ?? previewOf(outcome.scope_value),
      size_bytes: outcome.result_size_bytes,
      ...(outcome.result_sha256 ? { sha256: outcome.result_sha256 } : {}),
    };
    env.data = ref;
  }
  return env;
}
