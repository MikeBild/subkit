import { connectorHref, conversationHref, recordHref, workflowHref } from "@/app/links";

export type UseKind = "workflow" | "chat" | "task" | "intake" | "connector" | "other";

export interface UseRow {
  kind: UseKind;
  name: string;
  href: string;
  line?: string;
}

export interface Binding {
  scope: string | null | undefined;
  workflowId?: string | null | undefined;
  connectorId?: string | null | undefined;
}

export function boundTo(b: Binding): { kind: "workflow" | "connector"; id: string } | null {
  if (b.scope === "workflow" && b.workflowId?.trim()) return { kind: "workflow", id: b.workflowId };
  if (b.scope === "connector" && b.connectorId?.trim())
    return { kind: "connector", id: b.connectorId };
  return null;
}

export function recordUses({
  binding,
  bindingName,
  intake,
  target,
  conversations,
}: {
  binding: { kind: "workflow" | "connector"; id: string } | null;
  bindingName: string | null;
  intake: readonly {
    id: string;
    title: string;
    admitted_target_kind?: string | null;
    admitted_target_id?: string | null;
  }[];
  target: { kind: "knowledge" | "skill"; id: string };
  conversations: readonly { id: string; title?: string | null }[];
}): UseRow[] {
  const rows: UseRow[] = [];
  if (binding)
    rows.push({
      kind: binding.kind,
      name: bindingName ?? "…",
      href: binding.kind === "workflow" ? workflowHref(binding.id) : connectorHref(binding.id),
    });
  for (const item of intake)
    if (item.admitted_target_kind === target.kind && item.admitted_target_id === target.id)
      rows.push({
        kind: "intake",
        name: item.title,
        href: recordHref("intake", item.id),
      });
  for (const c of conversations)
    rows.push({ kind: "chat", name: c.title || "…", href: conversationHref(c.id) });
  return rows;
}
