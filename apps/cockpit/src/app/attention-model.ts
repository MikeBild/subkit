import { ATTENTION_READ_PERMISSIONS } from "./navigation";

type Hidden = ReadonlyMap<string, string>;

export function canReadAttention(permissions: readonly string[]): boolean {
  return ATTENTION_READ_PERMISSIONS.some((permission) => permissions.includes(permission));
}

export function withHidden(hidden: Hidden, id: string, snapshot: string): Hidden {
  return new Map([...hidden, [id, snapshot]]);
}

export function withoutHidden(hidden: Hidden, id: string): Hidden {
  if (!hidden.has(id)) return hidden;
  const next = new Map(hidden);
  next.delete(id);
  return next;
}

export function inboxCount(
  items: readonly { reason: string; counts: { intake?: number | null } }[],
): number {
  return items
    .filter((item) => item.reason === "intake_collected")
    .reduce((sum, item) => sum + Math.max(1, item.counts.intake ?? 1), 0);
}
