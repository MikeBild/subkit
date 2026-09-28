import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { apiRequest } from "@/api/client";
import { type Attention, attentionBadge } from "@/pages/today-model";
import { ATTENTION_READ_PERMISSIONS } from "./navigation";

// Entries decided in this tab, hidden until the engine stops listing them.
//
// The engine keeps a tenant's attention facts for ten seconds per process, so
// the read right after a decision can still carry the entry that was just
// settled. Removing it from the cache alone would bring it back on that read
// and take it away again on the next — a flicker that reads as "it did not
// work". So a decided entry stays hidden until an answer arrives WITHOUT it;
// after that it is shown again if it ever comes back, because then it is new.
let hidden: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish(next: ReadonlySet<string>): void {
  hidden = next;
  for (const listener of listeners) listener();
}

export function hideAttentionEntry(id: string): void {
  if (hidden.has(id)) return;
  publish(new Set([...hidden, id]));
}

/** A decision that failed brings its entry back. */
export function restoreAttentionEntry(id: string): void {
  if (!hidden.has(id)) return;
  const next = new Set(hidden);
  next.delete(id);
  publish(next);
}

/** Forget every hidden id the engine no longer lists. */
export function settleHiddenAttention(listed: readonly string[]): void {
  const present = new Set(listed);
  const next = new Set([...hidden].filter((id) => present.has(id)));
  if (next.size !== hidden.size) publish(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHiddenAttention(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => hidden,
    () => hidden,
  );
}

export function canReadAttention(permissions: readonly string[]): boolean {
  return ATTENTION_READ_PERMISSIONS.some((permission) => permissions.includes(permission));
}

/**
 * One query behind Heute and the navigation badge, so the badge can never
 * disagree with the list it links to.
 */
export function useAttention(permissions: readonly string[]) {
  const enabled = canReadAttention(permissions);
  const query = useQuery({
    queryKey: ["attention"],
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      const attention = await apiRequest<Attention>("/v1/attention");
      settleHiddenAttention(attention.items.map((item) => item.id));
      return attention;
    },
  });
  const hiddenIds = useHiddenAttention();
  return {
    enabled,
    query,
    hidden: hiddenIds,
    badge: attentionBadge(query.data, hiddenIds),
  };
}
