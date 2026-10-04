export type DiffHunk = { kind: "+" | "-" | " "; text: string };

export function computeLineDiff(
  before: string,
  after: string,
  options: { context?: number } = {},
): DiffHunk[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const m = a.length;
  const n = b.length;
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

  const context = options.context ?? 3;
  const compact: DiffHunk[] = [];
  for (let k = 0; k < raw.length; k++) {
    const h = raw[k] as DiffHunk;
    if (h.kind !== " ") {
      compact.push(h);
      continue;
    }
    let runEnd = k;
    while (runEnd < raw.length && (raw[runEnd] as DiffHunk).kind === " ") runEnd++;
    const runLen = runEnd - k;
    if (runLen <= context * 2 || compact.length === 0 || runEnd === raw.length) {
      for (let p = k; p < runEnd; p++) compact.push(raw[p] as DiffHunk);
    } else {
      for (let p = 0; p < context; p++) compact.push(raw[k + p] as DiffHunk);
      compact.push({ kind: " ", text: "…" });
      for (let p = runLen - context; p < runLen; p++) compact.push(raw[k + p] as DiffHunk);
    }
    k = runEnd - 1;
  }
  return compact;
}

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
