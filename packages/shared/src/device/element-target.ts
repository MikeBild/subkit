import { z } from "zod";

export const ELEMENT_NTH_MAX = 99;

export const ElementTargetSchema = z
  .object({
    role: z.string().trim().min(1).max(64),
    name: z.string().max(500),
    nth: z.number().int().min(0).max(ELEMENT_NTH_MAX).optional(),
  })
  .strict();
export type ElementTarget = z.infer<typeof ElementTargetSchema>;

export interface ElementEntry {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
}

export type ElementPick =
  | { ok: true; ref: string }
  | { ok: false; code: "element_not_found" | "element_ambiguous"; matches: number };

const SNAPSHOT_LINE = /^\s*-\s+([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?.*[[ ,]ref=(e\d{1,6})\]/;

function record(value: unknown): Record<string, unknown> {
  return Object(value) as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function fromRefs(refs: Record<string, unknown>): ElementEntry[] {
  const entries: ElementEntry[] = [];
  for (const [ref, raw] of Object.entries(refs)) {
    const entry = record(raw);
    const role = text(entry.role);
    if (!/^e\d{1,6}$/.test(ref) || role === "") continue;
    entries.push({ ref, role, name: text(entry.name) });
  }
  return entries;
}

function fromText(snapshot: string): ElementEntry[] {
  const entries: ElementEntry[] = [];
  for (const line of snapshot.split("\n")) {
    const match = SNAPSHOT_LINE.exec(line);
    if (!match) continue;
    entries.push({
      ref: match[3] as string,
      role: match[1] as string,
      name: (match[2] ?? "").replace(/\\(.)/g, "$1"),
    });
  }
  return entries;
}

export function browserSnapshotElements(output: unknown): ElementEntry[] {
  const snapshot = typeof output === "string" ? output : record(output).snapshot;
  if (typeof snapshot === "string") return fromText(snapshot);
  const data = record(snapshot);
  const listed = fromRefs(record(data.refs));
  return listed.length > 0 ? listed : fromText(text(data.snapshot));
}

export function computerTreeElements(tree: unknown): ElementEntry[] {
  const entries: ElementEntry[] = [];
  const visit = (node: unknown) => {
    const current = record(node);
    const ref = text(current.ref);
    const role = text(current.role);
    if (ref !== "" && role !== "") entries.push({ ref, role, name: text(current.name) });
    if (Array.isArray(current.children)) for (const child of current.children) visit(child);
  };
  visit(tree);
  return entries;
}

const COMPUTER_REF_KINDS: ReadonlySet<string> = new Set([
  "computer.press",
  "computer.focus",
  "computer.select",
  "computer.set_value",
  "computer.type",
  "computer.scroll",
]);

export function needsFreshSnapshot(kind: string, args: unknown): boolean {
  if (COMPUTER_REF_KINDS.has(kind)) return true;
  if (!kind.startsWith("browser.")) return false;
  return typeof record(args).ref === "string";
}

export function pickElement(entries: readonly ElementEntry[], target: ElementTarget): ElementPick {
  const role = target.role.trim().toLowerCase();
  const name = normalized(target.name);
  const matches = entries.filter(
    (entry) => entry.role.toLowerCase() === role && normalized(entry.name) === name,
  );
  if (target.nth !== undefined) {
    const chosen = matches[target.nth];
    return chosen
      ? { ok: true, ref: chosen.ref }
      : { ok: false, code: "element_not_found", matches: matches.length };
  }
  if (matches.length === 1) return { ok: true, ref: (matches[0] as ElementEntry).ref };
  return {
    ok: false,
    code: matches.length === 0 ? "element_not_found" : "element_ambiguous",
    matches: matches.length,
  };
}
