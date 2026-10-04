import type { StepWarning } from "../types.ts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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

function envelopeData(v: unknown): unknown {
  if (isPlainObject(v) && "data" in v) return (v as { data: unknown }).data;
  return v;
}

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

export function detectTransformWarnings(p: {
  step_id: string;
  output: unknown;
  scope: Record<string, unknown>;
}): StepWarning[] {
  const warnings: StepWarning[] = [];
  const upstream = upstreamDataValues(p.scope);
  const upstreamHadData = upstream.some((v) => !isEmptyValue(v));

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
    return warnings;
  }

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
