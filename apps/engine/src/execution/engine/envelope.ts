import { isOffloadRef, type OffloadRef, OffloadResolutionError, previewOf } from "../offload.ts";
import type { RunStepOutcome } from "../step-runner.ts";
import type { HeldRequest, StepResult } from "../types.ts";

export function validateAgainstJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
  location: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!schema || typeof schema !== "object") return { valid: true, errors: [] };
  const obj =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const required = schema.required as string[] | undefined;
  if (required && Array.isArray(required) && required.length > 0) {
    for (const field of required) {
      if (!obj || !(field in obj)) {
        errors.push(`${location}: required field '${field}' is missing`);
      }
    }
  }
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : null;
  if (obj && properties) {
    for (const [field, rawSpec] of Object.entries(properties)) {
      if (!(field in obj)) continue;
      if (!rawSpec || typeof rawSpec !== "object") continue;
      const spec = rawSpec as Record<string, unknown>;
      const fieldValue = obj[field];
      const expectedType = typeof spec.type === "string" ? spec.type : null;
      if (expectedType && !matchesJsonSchemaType(fieldValue, expectedType)) {
        errors.push(`${location}: field '${field}' must be type '${expectedType}'`);
        continue;
      }
      const enumValues = Array.isArray(spec.enum) ? spec.enum : null;
      if (enumValues && enumValues.length > 0 && !enumValues.includes(fieldValue)) {
        const rendered = enumValues.map((v) => JSON.stringify(v)).join(", ");
        errors.push(`${location}: field '${field}' must be one of [${rendered}]`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function matchesJsonSchemaType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

export interface ScopeEnvelope {
  data: unknown;
  status_code?: number;
  headers?: Record<string, string>;
  duration_ms: number;
  error: { code: string; message: string; details?: unknown } | null;
  held?: true;
  held_request?: HeldRequest;
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
  }
  return env;
}

export type BodyEnvelopeVerdict = "productive" | "offloaded" | "empty";

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
