export type PatchOperationChange = "added" | "removed" | "changed";

export interface PatchOperation {
  index: number;
  path: string;
  line: number | null;
  change: PatchOperationChange;
  before: unknown;
  after: unknown;
  description_key: string;
}

export interface AcceptedSelection {
  indices: number[];
  partial: boolean;
}

type Json = Record<string, unknown>;

const NAMED_SLOTS = new Set(["data_selector", "expression", "report_delivery"]);

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function walkable(value: Json): boolean {
  return Object.keys(value).every((key) => key.length > 0 && !key.includes("."));
}

function descriptionKey(path: string, line: number | null, change: PatchOperationChange): string {
  const top = path.split(".")[0] ?? "";
  const slot = NAMED_SLOTS.has(top) ? top : "field";
  return `patch_operation.${slot}_${line === null ? change : "line_changed"}`;
}

type Draft = Omit<PatchOperation, "index" | "description_key">;

function diffLines(path: string, before: string, after: string): Draft[] | null {
  const from = before.split("\n");
  const to = after.split("\n");
  if (from.length < 2 || from.length !== to.length) return null;
  return from.flatMap((text, i) =>
    text === to[i]
      ? []
      : [{ path, line: i + 1, change: "changed" as const, before: text, after: to[i] }],
  );
}

function walk(path: string, before: unknown, after: unknown, out: Draft[]): void {
  if (same(before, after)) return;
  if (isRecord(before) && isRecord(after) && walkable(before) && walkable(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) walk(path ? `${path}.${key}` : key, before[key], after[key], out);
    return;
  }
  const lines =
    typeof before === "string" && typeof after === "string" ? diffLines(path, before, after) : null;
  if (lines) {
    out.push(...lines);
    return;
  }
  const change: PatchOperationChange =
    before === undefined || before === null
      ? "added"
      : after === undefined || after === null
        ? "removed"
        : "changed";
  out.push({ path, line: null, change, before: before ?? null, after: after ?? null });
}

export function patchOperations(before: Json, after: Json): PatchOperation[] {
  if (!walkable(before) || !walkable(after)) return [];
  const drafts: Draft[] = [];
  walk("", before, after, drafts);
  return drafts.map((draft, index) => ({
    index,
    ...draft,
    description_key: descriptionKey(draft.path, draft.line, draft.change),
  }));
}

export function selectAccepted(
  operations: readonly PatchOperation[],
  accepted: readonly number[] | null | undefined,
): AcceptedSelection | null {
  if (accepted === null || accepted === undefined)
    return { indices: operations.map((operation) => operation.index), partial: false };
  const unique = [...new Set(accepted)].sort((a, b) => a - b);
  const valid =
    unique.length > 0 &&
    unique.length === accepted.length &&
    unique.every((index) => Number.isInteger(index) && index >= 0 && index < operations.length);
  return valid ? { indices: unique, partial: unique.length < operations.length } : null;
}

function writeAt(root: Json, segments: string[], operation: PatchOperation): void {
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (!isRecord(next)) return;
    node = next;
  }
  const leaf = segments[segments.length - 1];
  if (leaf === undefined) return;
  if (operation.line !== null) {
    const current = node[leaf];
    if (typeof current !== "string" || typeof operation.after !== "string") return;
    const lines = current.split("\n");
    lines[operation.line - 1] = operation.after;
    node[leaf] = lines.join("\n");
  } else if (operation.change === "removed") {
    delete node[leaf];
  } else {
    node[leaf] = structuredClone(operation.after);
  }
}

export function applyAccepted(
  before: Json,
  operations: readonly PatchOperation[],
  accepted: readonly number[],
): Json {
  const next = structuredClone(before);
  const wanted = new Set(accepted);
  for (const operation of operations) {
    if (wanted.has(operation.index)) writeAt(next, operation.path.split("."), operation);
  }
  return next;
}
