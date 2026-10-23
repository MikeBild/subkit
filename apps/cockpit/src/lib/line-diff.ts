export type DiffLineType = "context" | "removed" | "added";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export function toDiffLines(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const text = typeof value === "string" ? value : JSON.stringify(value, sortedKeys(value), 2);
  return text.split("\n");
}

function sortedKeys(_value: unknown): (key: string, val: unknown) => unknown {
  return (_key, val) => {
    if (val === null || typeof val !== "object" || Array.isArray(val)) return val;
    const record = val as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  };
}

export function computeLineDiff(before: readonly string[], after: readonly string[]): DiffLine[] {
  const rows = before.length;
  const cols = after.length;
  const width = cols + 1;
  const table = new Int32Array((rows + 1) * width);
  const at = (source: readonly string[], index: number): string => source[index] ?? "";
  const cell = (row: number, col: number): number => table[row * width + col] ?? 0;
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i * width + j] =
        at(before, i) === at(after, j)
          ? cell(i + 1, j + 1) + 1
          : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (at(before, i) === at(after, j)) {
      lines.push({ type: "context", text: at(before, i) });
      i++;
      j++;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      lines.push({ type: "removed", text: at(before, i) });
      i++;
    } else {
      lines.push({ type: "added", text: at(after, j) });
      j++;
    }
  }
  while (i < rows) lines.push({ type: "removed", text: at(before, i++) });
  while (j < cols) lines.push({ type: "added", text: at(after, j++) });
  return lines;
}

export function isUnchanged(lines: readonly DiffLine[]): boolean {
  return lines.every((line) => line.type === "context");
}

export type FocusedRow = DiffLine | { type: "gap"; count: number };

export function focusDiff(lines: readonly DiffLine[], context = 2): FocusedRow[] {
  if (isUnchanged(lines)) return [];
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.type === "context") return;
    const last = Math.min(lines.length - 1, index + context);
    for (let near = Math.max(0, index - context); near <= last; near++) keep[near] = true;
  });
  const rows: FocusedRow[] = [];
  let gap = 0;
  lines.forEach((line, index) => {
    if (!keep[index]) {
      gap++;
      return;
    }
    if (gap > 0) rows.push({ type: "gap", count: gap });
    gap = 0;
    rows.push(line);
  });
  if (gap > 0) rows.push({ type: "gap", count: gap });
  return rows;
}

export interface DiffSides {
  before: FocusedRow[];
  after: FocusedRow[];
}

export function splitSides(rows: readonly FocusedRow[]): DiffSides {
  return {
    before: rows.filter((row) => row.type !== "added"),
    after: rows.filter((row) => row.type !== "removed"),
  };
}

export type ChangeView =
  | { kind: "diff"; lines: DiffLine[] }
  | { kind: "patch"; lines: string[] }
  | { kind: "unchanged" };

export function selectChangeView(input: {
  before: unknown;
  after: unknown;
  patch: unknown;
}): ChangeView {
  const lines = computeLineDiff(toDiffLines(input.before), toDiffLines(input.after));
  if (lines.length > 0 && !isUnchanged(lines)) return { kind: "diff", lines };
  const patchLines = toDiffLines(input.patch);
  if (patchLines.length > 0) return { kind: "patch", lines: patchLines };
  return { kind: "unchanged" };
}
