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

function useHiddenAttention(): HiddenEntries {
  return useSyncExternalStore(
    subscribe,
    () => hidden,
    () => hidden,
  );
}

function canReadAttention(permissions: readonly string[]): boolean {
  return ATTENTION_READ_PERMISSIONS.some((permission) => permissions.includes(permission));
}

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
