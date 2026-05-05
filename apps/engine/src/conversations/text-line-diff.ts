// Minimal line-by-line unified diff. Used by mutation tools
// (build_workflow, update_param, edit_workflow_patch, save_connector)
// to emit structural-change visualisations the CLI renders inline as
// codex-style patch cells.
//
// Algorithm: O(n*m) longest-common-subsequence — fine for our payloads
// (workflow DAGs are <1000 lines). No external dependency, no syntax
// awareness; the renderer paints by line kind.

export type DiffHunk = { kind: "+" | "-" | " "; text: string };

export function computeLineDiff(
  before: string,
  after: string,
  options: { context?: number } = {},
): DiffHunk[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // LCS via dynamic programming.
  const m = a.length;
  const n = b.length;
  // dp is allocated with m+1 rows above; every dp[i] for i in [0, m] exists.
  // TS can't see that, so the asserts are load-bearing.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const row = dp[i] as number[];
      if (a[i] === b[j]) row[j] = (dp[i + 1]?.[j + 1] ?? 0) + 1;
      else row[j] = Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
    }
  }
  const raw: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      raw.push({ kind: " ", text: a[i] ?? "" });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      raw.push({ kind: "-", text: a[i] ?? "" });
      i++;
    } else {
      raw.push({ kind: "+", text: b[j] ?? "" });
      j++;
    }
  }
  while (i < m) raw.push({ kind: "-", text: a[i++] ?? "" });
  while (j < n) raw.push({ kind: "+", text: b[j++] ?? "" });

  // Context elision: keep `context` lines around each change run, drop
  // long unchanged stretches with a `…` placeholder. Mirrors codex's
  // collapse-large-runs behaviour. Default 3 lines of context.
  const context = options.context ?? 3;
  const compact: DiffHunk[] = [];
  // Loop bounds (k < raw.length, p < runEnd, etc.) prove every raw[<idx>]
  // is defined, but TS's noUncheckedIndexedAccess treats array reads as
  // T | undefined regardless. The asserts below are load-bearing.
  for (let k = 0; k < raw.length; k++) {
    const h = raw[k] as DiffHunk;
    if (h.kind !== " ") {
      compact.push(h);
      continue;
    }
    // unchanged line — find run length
    let runEnd = k;
    while (runEnd < raw.length && (raw[runEnd] as DiffHunk).kind === " ") runEnd++;
    const runLen = runEnd - k;
    if (runLen <= context * 2 || compact.length === 0 || runEnd === raw.length) {
      // short run, OR leading run on first change, OR trailing run on last change
      // — keep as-is.
      for (let p = k; p < runEnd; p++) compact.push(raw[p] as DiffHunk);
    } else {
      // long run with changes both before and after — keep `context`
      // lines on each end, replace middle with a single ellipsis.
      for (let p = 0; p < context; p++) compact.push(raw[k + p] as DiffHunk);
      compact.push({ kind: " ", text: "…" });
      for (let p = runLen - context; p < runLen; p++) compact.push(raw[k + p] as DiffHunk);
    }
    k = runEnd - 1;
  }
  return compact;
}

/** Pretty-print a workflow DAG / connector config for diff rendering.
 *  Sorted-key JSON so semantically-equal payloads diff cleanly. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value, null, 2) ?? "null";
  const replacer = (_key: string, v: unknown): unknown => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  };
  return JSON.stringify(value, replacer, 2) ?? "null";
}
