import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { apiRequest } from "@/api/client";
import {
  type Attention,
  type AttentionItem,
  attentionBadge,
  entrySnapshot,
  type HiddenEntries,
  NO_HIDDEN,
  settleHidden,
} from "@/pages/overview-model";
import { useLiveQueryOptions } from "./live-events";
import { ATTENTION_READ_PERMISSIONS } from "./navigation";

// Entries decided in this tab, hidden as what they were when decided.
//
// A decided entry leaves the list at once. It stays away while the engine
// still lists it UNCHANGED — the read right after a decision can predate it —
// and it is back the moment the engine lists it as anything else: the last fix
// of a failing workflow decided, the workflow still failing, now with a chat
// as its way forward. `settleHidden` in the model owns that rule.
let hidden: HiddenEntries = NO_HIDDEN;
const listeners = new Set<() => void>();

function publish(next: HiddenEntries): void {
  if (next === hidden) return;
  hidden = next;
  for (const listener of listeners) listener();
}

export function hideAttentionEntry(item: AttentionItem): void {
  publish(new Map([...hidden, [item.id, entrySnapshot(item)]]));
}

/** A decision that failed brings its entry back. */
export function restoreAttentionEntry(id: string): void {
  if (!hidden.has(id)) return;
  const next = new Map(hidden);
  next.delete(id);
  publish(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHiddenAttention(): HiddenEntries {
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
 * One query behind Übersicht and the navigation badge, so the badge can never
 * disagree with the list it links to.
 */
export function useAttention(permissions: readonly string[]) {
  const enabled = canReadAttention(permissions);
  const live = useLiveQueryOptions();
  const query = useQuery({
    queryKey: ["attention"],
    enabled,
    ...live,
    staleTime: 30_000,
    queryFn: async () => {
      const attention = await apiRequest<Attention>("/v1/attention");
      publish(settleHidden(hidden, attention.items));
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
