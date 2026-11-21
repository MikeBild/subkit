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
  pairWaitingFor,
  settleHidden,
  waitingOnName,
} from "@/pages/overview-model";
import { canReadAttention, withHidden, withoutHidden } from "./attention-model";
import { useLiveQueryOptions } from "./live-events";

let hidden: HiddenEntries = NO_HIDDEN;
const listeners = new Set<() => void>();

function publish(next: HiddenEntries): void {
  if (next === hidden) return;
  hidden = next;
  for (const listener of listeners) listener();
}

export function hideAttentionEntry(item: AttentionItem): void {
  publish(withHidden(hidden, item.id, entrySnapshot(item)));
}

export function restoreAttentionEntry(id: string): void {
  publish(withoutHidden(hidden, id));
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

export function useWaitingOn(
  subjectId: string | null | undefined,
  permissions: readonly string[],
): string | null {
  const attention = useAttention(permissions);
  return waitingOnName(attention.query.data, subjectId);
}

export function usePairWaiting(
  subjectId: string | null | undefined,
  permissions: readonly string[],
): { waitingOn: string | null } | null {
  const attention = useAttention(permissions);
  return pairWaitingFor(attention.query.data, subjectId);
}
