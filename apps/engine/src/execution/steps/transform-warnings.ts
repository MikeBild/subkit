// Transform-step quality warnings — silent-data-loss detection.
//
// Two warning codes were defined in execution/types.ts AND consumed by the
// dry-run repair loop (dry-run-repair.ts, dry-run-workflow.ts), but NOTHING
// ever emitted them — the detection was specified and abandoned. This module
// is the missing emit. It runs on a transform's SUCCEEDED output and compares
// it against the upstream scope it could have drawn from:
//
//   transform_empty_extraction (BLOCKING at dry-run) — the transform produced
//     an empty result (null / [] / {} / "") while at least one upstream step
//     carried non-empty data. The classic "JS/JSONata path was wrong, or an
//     unhandled case returned empty, and everything silently vanished" bug —
//     e.g. a Notion block renderer that returns "" for every block type it
//     doesn't recognise.
//
//   transform_dropped_fields (INFORMATIONAL) — the transform mapped over a
//     non-empty array and emitted an array of the SAME length whose object
//     keys are a strict subset of the source items' keys. A strong hint the
//     projection silently dropped fields (session 3f6082d2: format_output
//     dropped the `resources` field). Advisory only — reshaping that
//     intentionally narrows is legitimate, so this never blocks a commit.
//
// Detection is purely structural (no JS parsing) and deliberately
// conservative on the advisory code: dropped-fields fires only when EXACTLY
// ONE same-length candidate source array exists, so an ambiguous match never
// produces a false warning.

import type { StepWarning } from "../types.ts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Empty in the "extraction produced nothing" sense: null/undefined, [], {}, "". */
function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "string") return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

function describeEmpty(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "empty array";
  if (typeof v === "string") return "empty string";
  if (isPlainObject(v)) return "empty object";
  return String(v);
}

/**
 * Unwrap the canonical scope envelope. Every step output lands in scope as
 * `{ data: <output>, … }` (engine.ts `wrapEnvelope`), so the real upstream
 * payload is `value.data`. Non-enveloped values pass through unchanged.
 */
function envelopeData(v: unknown): unknown {
  if (isPlainObject(v) && "data" in v) return (v as { data: unknown }).data;
  return v;
}

/** Upstream step payloads in scope, skipping the `$`-prefixed JSONata bindings. */
function upstreamDataValues(scope: Record<string, unknown>): unknown[] {
  return Object.entries(scope)
    .filter(([k]) => !k.startsWith("$"))
    .map(([, v]) => envelopeData(v));
}

function unionKeys(rows: Record<string, unknown>[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) keys.add(k);
  return keys;
}

/**
 * Inspect a transform's output against the scope it ran over and return any
 * silent-data-loss warnings. Pure — no DB, no side effects.
 */
export function detectTransformWarnings(p: {
  step_id: string;
  output: unknown;
  scope: Record<string, unknown>;
}): StepWarning[] {
  const warnings: StepWarning[] = [];
  const upstream = upstreamDataValues(p.scope);
  const upstreamHadData = upstream.some((v) => !isEmptyValue(v));

  // transform_empty_extraction — empty output despite non-empty upstream data.
  if (isEmptyValue(p.output) && upstreamHadData) {
    warnings.push({
      code: "transform_empty_extraction",
      identifier: p.step_id,
      message: `transform "${p.step_id}" produced an empty result (${describeEmpty(
        p.output,
      )}) while upstream steps carried non-empty data — the projection likely matched nothing (wrong field path, or an unhandled case that returns empty). Verify the paths against the upstream output with inspect_workflow_draft.`,
      details: {
        output_kind: describeEmpty(p.output),
        upstream_step_count: upstream.length,
      },
    });
    // An empty output can't also "drop fields" — return early.
    return warnings;
  }

  // transform_dropped_fields — mapped array whose item keys strictly narrow a
  // same-length source array's item keys. Conservative: only a UNIQUE
  // same-length object-array source qualifies (ambiguity → no warning).
  if (Array.isArray(p.output) && p.output.length > 0 && p.output.every(isPlainObject)) {
    const outKeys = unionKeys(p.output as Record<string, unknown>[]);
    const candidates = upstream.filter(
      (v): v is Record<string, unknown>[] =>
        Array.isArray(v) &&
        v.length === (p.output as unknown[]).length &&
        v.length > 0 &&
        v.every(isPlainObject),
    );
    if (candidates.length === 1) {
      const source = candidates[0] as Record<string, unknown>[];
      const srcKeys = unionKeys(source);
      const dropped = [...srcKeys].filter((k) => !outKeys.has(k));
      const outIsSubset = [...outKeys].every((k) => srcKeys.has(k));
      if (dropped.length > 0 && outIsSubset) {
        warnings.push({
          code: "transform_dropped_fields",
          identifier: p.step_id,
          message: `transform "${p.step_id}" mapped over a ${source.length}-item array but its output objects drop field(s) present in the source: ${dropped.join(
            ", ",
          )}. If narrowing is intentional, ignore; otherwise add the field(s) to the projection.`,
          details: {
            dropped_fields: dropped,
            output_keys: [...outKeys],
            source_keys: [...srcKeys],
          },
        });
      }
    }
  }

  return warnings;
}
