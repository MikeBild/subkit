import type { AttentionItem } from "./attention.ts";

export const HANDOVER_COMMAND_KINDS = ["browser.handover", "computer.handover"] as const;

export interface HandoverCommandRow {
  device_id: string;
  device_label: string;
  owner_user_id: string;
  claimed_at: Date;
  deadline_at: Date;
  execution_id: string | null;
  conversation_id: string | null;
}

export interface WaitingHandover {
  device_id: string;
  device_label: string;
  owner_user_id: string;
  steps: number;
  since: Date;
  deadline: Date;
  href: string;
}

const DEVICES_HREF = "/cockpit/settings?area=devices";

function handoverHref(rows: readonly HandoverCommandRow[]): string {
  const first = rows[0];
  if (rows.length !== 1 || !first) return DEVICES_HREF;
  if (first.conversation_id) return `/cockpit/chat/${encodeURIComponent(first.conversation_id)}`;
  if (first.execution_id) return `/cockpit/runs/${encodeURIComponent(first.execution_id)}`;
  return DEVICES_HREF;
}

export function projectHandovers(rows: readonly HandoverCommandRow[]): WaitingHandover[] {
  const byDevice = new Map<string, HandoverCommandRow[]>();
  for (const row of rows)
    byDevice.set(row.device_id, [...(byDevice.get(row.device_id) ?? []), row]);
  return [...byDevice.values()].flatMap((group) => {
    const first = group[0];
    if (!first) return [];
    return [
      {
        device_id: first.device_id,
        device_label: first.device_label,
        owner_user_id: first.owner_user_id,
        steps: group.length,
        since: new Date(Math.min(...group.map((row) => row.claimed_at.getTime()))),
        deadline: new Date(Math.min(...group.map((row) => row.deadline_at.getTime()))),
        href: handoverHref(group),
      },
    ];
  });
}

export function handoverAttentionItem(handover: WaitingHandover): AttentionItem {
  return {
    id: `device_handover:${handover.device_id}`,
    class: "decide",
    severity: "urgent",
    kind: "device_handover_waiting",
    subject: { kind: "device", id: handover.device_id, name: handover.device_label },
    reason: "device_handover_waiting",
    trigger: null,
    cause_class: null,
    counts: {},
    since: handover.since.toISOString(),
    deadline: handover.deadline.toISOString(),
    detail: `${handover.steps} ${handover.steps === 1 ? "step waits" : "steps wait"} for you to take over on this device`,
    actions: [{ verb: "open", href: handover.href, primary: true, permission: "device:read" }],
  };
}
