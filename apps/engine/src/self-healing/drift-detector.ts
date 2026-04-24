// Drift detector.
//
// Given a failing `execution_steps` row + its step-result snapshot + the
// last known `SchemaShape` for the endpoint, return either a typed
// `DriftSignal` or `null`. Nulls mean "this is a normal failure, not
// self-healable" — the caller continues along the retry/backoff path.
//
// The detector never mutates inputs and never reads from the database.
// It is a pure function the loop composes with `getLatestShape` on one
// side and the repair queue on the other.

import { deriveShape, diffShapes } from "../schema-versions/service.ts";
import type { DriftSignal, SchemaShape } from "./types.ts";

/** Minimal view of the failing step the detector needs. */
export interface FailingStepSnapshot {
  id: string;
  kind: string;
  status: string;
  error?: unknown;
  request_meta?: unknown;
  output_preview?: unknown;
  // `expression` is populated when the failing step is a transform.
  expression?: string;
}

function asObj(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

/**
 * Analyse a failing step. The detector consumes whatever structure the
 * driver left in the row:
 *
 *   - `error.kind === "http"` + `error.status >= 400` + `error.body` →
 *     check whether the new body shape differs from the recorded
 *     `schema_versions` row. If it does, emit `http_status_new_shape`.
 *   - `error.kind === "jsonata_miss"` + `error.expression` +
 *     `error.missing_path` → emit `jsonata_path_miss`.
 *   - Anything else with a recorded shape diff at the top level →
 *     emit `schema_diff`.
 *   - Otherwise `null`.
 *
 * The detector trusts the driver to tag errors in a normalised envelope
 * — if a driver emits a raw `{ error: "boom" }` we fall through to
 * null and the retry path handles it.
 */
export function analyzeStepFailure(
  step: FailingStepSnapshot,
  lastKnownShape: SchemaShape | null,
): DriftSignal | null {
  const err = asObj(step.error);
  if (!err) return null;

  // --- JSONata path miss --------------------------------------------------
  if (err.kind === "jsonata_miss" || err.kind === "jsonata_path_miss") {
    const expression =
      typeof err.expression === "string" ? err.expression : (step.expression ?? "");
    const missing_path = typeof err.missing_path === "string" ? err.missing_path : "";
    if (expression && missing_path) {
      return {
        kind: "jsonata_path_miss",
        expression,
        missing_path,
        prior_value: err.prior_value ?? null,
      };
    }
  }

  // --- HTTP 4xx/5xx with a new error shape -------------------------------
  if (err.kind === "http") {
    const statusRaw = err.status;
    const status =
      typeof statusRaw === "number" ? statusRaw : Number.parseInt(String(statusRaw), 10);
    const body = err.body;
    if (Number.isFinite(status) && status >= 400 && body !== undefined) {
      const after = deriveShape(body);
      // Only surface as drift if the new body shape *differs* from the
      // last known successful shape for this endpoint. A 500 that still
      // matches the known error envelope is not drift.
      if (lastKnownShape && !shapesEqual(lastKnownShape, after)) {
        const reqMeta = asObj(step.request_meta) ?? {};
        return {
          kind: "http_status_new_shape",
          status,
          request: {
            method: typeof reqMeta.method === "string" ? (reqMeta.method as string) : undefined,
            url: typeof reqMeta.url === "string" ? (reqMeta.url as string) : undefined,
            path: typeof reqMeta.path === "string" ? (reqMeta.path as string) : undefined,
          },
          response_before: lastKnownShape,
          response_after: after,
        };
      }
    }
  }

  // --- Schema diff against recorded successful shape ---------------------
  if (lastKnownShape) {
    const captured = err.captured_response ?? step.output_preview;
    if (captured !== undefined) {
      const after = deriveShape(captured);
      if (!shapesEqual(lastKnownShape, after)) {
        const { added, removed, widened } = diffShapes(lastKnownShape, after);
        if (added.length + removed.length + widened.length > 0) {
          return {
            kind: "schema_diff",
            before: lastKnownShape,
            after,
            added,
            removed,
            widened,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Render a DriftSignal as a compact text block for the LLM prompt. The
 * `repair` flow forwards this unchanged through `assembleEnhancedPrompt`
 * as `PriorFailure.schema_diff`, so the signal becomes the grounding
 * evidence for the proposed patch.
 */
export function renderDriftDiff(signal: DriftSignal): string {
  switch (signal.kind) {
    case "jsonata_path_miss":
      return [
        `kind: jsonata_path_miss`,
        `expression: ${signal.expression}`,
        `missing_path: ${signal.missing_path}`,
      ].join("\n");
    case "http_status_new_shape": {
      const lines: string[] = [`kind: http_status_new_shape`, `status: ${signal.status}`];
      if (signal.request.method) lines.push(`request.method: ${signal.request.method}`);
      if (signal.request.url) lines.push(`request.url: ${signal.request.url}`);
      if (signal.request.path) lines.push(`request.path: ${signal.request.path}`);
      lines.push(`before: ${JSON.stringify(signal.response_before)}`);
      lines.push(`after: ${JSON.stringify(signal.response_after)}`);
      return lines.join("\n");
    }
    case "schema_diff":
      return [
        `kind: schema_diff`,
        `added: ${signal.added.join(", ") || "(none)"}`,
        `removed: ${signal.removed.join(", ") || "(none)"}`,
        `widened: ${signal.widened.join(", ") || "(none)"}`,
      ].join("\n");
    case "stdlib_version_drift":
      return [
        `kind: stdlib_version_drift`,
        `surface: ${signal.surface}`,
        `resource_id: ${signal.resource_id}`,
        `recorded_version: ${signal.recorded_version}`,
        `current_version: ${signal.current_version}`,
      ].join("\n");
  }
}

/** Structural equality on SchemaShape. */
function shapesEqual(a: SchemaShape, b: SchemaShape): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "object" && b.type === "object") {
    const aKeys = Object.keys(a.properties);
    const bKeys = Object.keys(b.properties);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      const av = a.properties[k];
      const bv = b.properties[k];
      if (!bv || !av) return false;
      if (!shapesEqual(av, bv)) return false;
    }
    return true;
  }
  if (a.type === "array" && b.type === "array") {
    return shapesEqual(a.items, b.items);
  }
  return true;
}
