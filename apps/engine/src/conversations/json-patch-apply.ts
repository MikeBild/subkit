import * as jsonpatch from "fast-json-patch";

export type ToolDiff = jsonpatch.Operation;

export function applyDiffsToConfig<T extends object>(config: T, diffs: ToolDiff[]): T {
  if (!diffs?.length) return config;
  const clone = JSON.parse(JSON.stringify(config)) as T;
  const result = jsonpatch.applyPatch(clone, diffs, true, true);
  return (result.newDocument as T) ?? clone;
}

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

export function applyApprovedDiffs<T extends object>(
  config: T,
  diffs: ToolDiff[],
  approvedIndices: ReadonlyArray<number>,
): T {
  const { approved } = partitionDiffs(diffs, approvedIndices);
  return applyDiffsToConfig(config, approved);
}
