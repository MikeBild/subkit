import type { components } from "@cli-core/engine-api/openapi";

export type Attention = components["schemas"]["AttentionV1"];
type AttentionAction = components["schemas"]["AttentionAction"];
export type AttentionItem = components["schemas"]["AttentionItem"];
export type AttentionSource = keyof Attention["sources"];
export type HiddenEntries = ReadonlyMap<string, string>;
export const NO_HIDDEN: HiddenEntries = new Map();
export type OverviewView =
  | { kind: "items"; items: AttentionItem[]; unread: AttentionSource[] }
  | { kind: "calm"; status: Attention["status"] }
  | { kind: "unread"; unread: AttentionSource[] }
  | { kind: "nothing_readable" };
export type OverviewSection = "operations" | "attention" | "calm" | "unread" | "history";

export function entrySnapshot(item: AttentionItem): string {
  return JSON.stringify([
    item.reason,
    item.class,
    item.counts,
    item.actions.find((action) => action.primary)?.verb ?? null,
  ]);
}
export function isHidden(item: AttentionItem, hidden: HiddenEntries): boolean {
  return hidden.get(item.id) === entrySnapshot(item);
}
export function settleHidden(
  hidden: HiddenEntries,
  items: readonly AttentionItem[],
): HiddenEntries {
  const byId = new Map(items.map((item) => [item.id, item]));
  const next = new Map(
    [...hidden].filter(([id, snapshot]) => {
      const item = byId.get(id);
      return item !== undefined && entrySnapshot(item) === snapshot;
    }),
  );
  return next.size === hidden.size ? hidden : next;
}
function subjectKey(item: AttentionItem): string {
  return item.subject ? `${item.subject.kind}:${item.subject.id}` : item.id;
}
export function attentionEntries(
  items: readonly AttentionItem[],
  hidden: HiddenEntries = NO_HIDDEN,
): AttentionItem[] {
  const seen = new Set<string>(),
    entries: AttentionItem[] = [];
  for (const item of items) {
    if (isHidden(item, hidden)) continue;
    const key = subjectKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(item);
  }
  return entries;
}
export function failedSources(attention: Attention): AttentionSource[] {
  return (Object.keys(attention.sources) as AttentionSource[]).filter(
    (source) => attention.sources[source] === "failed",
  );
}
export function overviewView(
  attention: Attention,
  hidden: HiddenEntries = NO_HIDDEN,
): OverviewView {
  const items = attentionEntries(attention.items, hidden),
    unread = failedSources(attention);
  if (items.length) return { kind: "items", items, unread };
  if (unread.length) return { kind: "unread", unread };
  return Object.values(attention.sources).some((state) => state !== "not_permitted")
    ? { kind: "calm", status: attention.status }
    : { kind: "nothing_readable" };
}
export function overviewSections(
  view: OverviewView,
  can: { operations: boolean; history: boolean },
): OverviewSection[] {
  const sections: OverviewSection[] = can.operations ? ["operations"] : [];
  if (view.kind === "items") {
    sections.push("attention");
    if (view.unread.length) sections.push("unread");
  } else if (view.kind === "calm") sections.push("calm");
  else if (view.kind === "unread") sections.push("unread");
  if (can.history) sections.push("history");
  return sections;
}
export function attentionBadge(
  attention: Attention | undefined,
  hidden: HiddenEntries = NO_HIDDEN,
): { count: number; stopped: boolean } | null {
  if (!attention) return null;
  const items = attentionEntries(attention.items, hidden);
  return items.length
    ? { count: items.length, stopped: items.some((item) => item.class === "stopped") }
    : null;
}

export function entryActions(item: AttentionItem): {
  primary: AttentionAction | null;
  secondary: AttentionAction | null;
} {
  const primary = item.actions.find((action) => action.primary) ?? null;
  const secondary = item.actions.find((action) => !action.primary) ?? null;
  return { primary, secondary };
}
