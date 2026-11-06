import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  type Attention,
  type AttentionItem,
  attentionEntries,
  failedSources,
  type HiddenEntries,
  NO_HIDDEN,
} from "@/pages/overview-model";
import { useAttention } from "./use-attention";

export const SEEN_MAX = 200;
const STORAGE_PREFIX = "subkit.attention.seen:";

type SeenKeys = ReadonlySet<string>;
type SeenStorage = Pick<Storage, "getItem" | "setItem">;

export interface AttentionFresh {
  stopped: boolean;
}

interface AttentionIdentity {
  tenant: { id: string };
  principal: { id: string };
  permissions: readonly string[];
}

export function attentionSeenKey(item: AttentionItem): string {
  return `${item.id}|${item.class}|${item.reason}`;
}

export function seenStorageKey(tenantId: string, principalId: string): string {
  return `${STORAGE_PREFIX}${tenantId}:${principalId}`;
}

export function unseenEntries(
  seen: SeenKeys | null,
  items: readonly AttentionItem[],
  hidden: HiddenEntries = NO_HIDDEN,
): AttentionItem[] {
  if (seen === null) return [];
  return attentionEntries(items, hidden).filter((item) => !seen.has(attentionSeenKey(item)));
}

export function nextSeen(
  seen: SeenKeys | null,
  items: readonly AttentionItem[],
  partial: boolean,
): SeenKeys {
  const current = items.map(attentionSeenKey);
  const kept = partial && seen ? [...seen] : [];
  return new Set([...current, ...kept].slice(0, SEEN_MAX));
}

function parseSeen(raw: string | null): SeenKeys | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
    return new Set(value);
  } catch {
    return null;
  }
}

export function createSeenStore(storage: () => SeenStorage | null) {
  const memory = new Map<string, SeenKeys>();
  const cache = new Map<string, SeenKeys | null>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const load = (key: string): SeenKeys | null => {
    try {
      const stored = parseSeen(storage()?.getItem(key) ?? null);
      if (stored) return stored;
    } catch {}
    return memory.get(key) ?? null;
  };
  return {
    read(key: string): SeenKeys | null {
      if (!cache.has(key)) cache.set(key, load(key));
      return cache.get(key) ?? null;
    },
    write(key: string, seen: SeenKeys): void {
      memory.set(key, seen);
      cache.set(key, seen);
      try {
        storage()?.setItem(key, JSON.stringify([...seen]));
      } catch {}
      notify();
    },
    external(key: string | null): void {
      if (key !== null && !key.startsWith(STORAGE_PREFIX)) return;
      if (key === null) cache.clear();
      else cache.delete(key);
      notify();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const store = createSeenStore(() => (typeof window === "undefined" ? null : window.localStorage));

if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => store.external(event.key));

function identityKey(identity: AttentionIdentity): string {
  return seenStorageKey(identity.tenant.id, identity.principal.id);
}

export function markAttentionSeen(identity: AttentionIdentity, attention: Attention): void {
  const key = identityKey(identity);
  store.write(key, nextSeen(store.read(key), attention.items, failedSources(attention).length > 0));
}

export function useAttentionFresh(identity: AttentionIdentity): AttentionFresh | null {
  const { enabled, query, hidden } = useAttention(identity.permissions);
  const key = identityKey(identity);
  const seen = useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.read(key), [key]),
    () => null,
  );
  const data = enabled && !query.isError ? query.data : undefined;
  useEffect(() => {
    if (data && store.read(key) === null) markAttentionSeen(identity, data);
  }, [data, key, identity]);
  if (!data) return null;
  const fresh = unseenEntries(seen, data.items, hidden);
  if (fresh.length === 0) return null;
  return { stopped: fresh.some((item) => item.class === "stopped") };
}
