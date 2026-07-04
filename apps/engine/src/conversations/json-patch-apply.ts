// JSON Patch helpers for per-patch partial approval.
//
// When a tool proposes a
// list of JSON-Patch operations and the operator approves only a
// subset (via the per-patch DiffApprovalComponent equivalent), this
// module applies the approved subset against the live config.
//
// Two functions, both pure and deterministic:
//   - `applyDiffsToConfig(config, diffs)` — apply every patch in
//     order. Returns the patched config, never mutates input.
//   - `selectApprovedDiffs(diffs, approvedIndices)` — pick the diffs
//     at the given indices, preserving order.

import * as jsonpatch from "fast-json-patch";

export type ToolDiff = jsonpatch.Operation;

/**
 * Apply a list of JSON-Patch operations to a config object. Empty
 * `diffs` returns the config unchanged. Always operates on a deep
 * clone — the input is never mutated. Validates and bails on the
 * first illegal patch.
 */
export function applyDiffsToConfig<T extends object>(config: T, diffs: ToolDiff[]): T {
  if (!diffs?.length) return config;
  const clone = JSON.parse(JSON.stringify(config)) as T;
  const result = jsonpatch.applyPatch(clone, diffs, true, true);
  return (result.newDocument as T) ?? clone;
}

/**
 * Partition a diff list into approved + rejected based on a
 * per-index decision map. Order within each output is preserved.
 * Used by the partial-approval auto-persist branch to pass only the
 * approved subset to `applyDiffsToConfig`.
 */
export function partitionDiffs(
  diffs: ToolDiff[],
  approvedIndices: ReadonlyArray<number>,
): { approved: ToolDiff[]; rejected: ToolDiff[] } {
  const approvedSet = new Set(approvedIndices);
  const approved: ToolDiff[] = [];
  const rejected: ToolDiff[] = [];
  for (let i = 0; i < diffs.length; i++) {
    const d = diffs[i];
    if (d === undefined) continue;
    if (approvedSet.has(i)) approved.push(d);
    else rejected.push(d);
  }
  return { approved, rejected };
}

/**
 * High-level convenience: given a config, full diff list, and the
 * indices of approved diffs, return the post-application config.
 */
export function applyApprovedDiffs<T extends object>(
  config: T,
  diffs: ToolDiff[],
  approvedIndices: ReadonlyArray<number>,
): T {
  const { approved } = partitionDiffs(diffs, approvedIndices);
  return applyDiffsToConfig(config, approved);
}
