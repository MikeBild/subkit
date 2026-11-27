import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";
import { keyId } from "./live-invalidation";

export const INVALIDATION_QUIET_MS = 450;
export const INVALIDATION_MAX_WAIT_MS = 2_000;

export interface InvalidationBatcher {
  schedule(keys: readonly QueryKey[]): void;
  now(keys: readonly QueryKey[]): Promise<void>;
  everything(): void;
  dispose(): void;
}

interface BatcherOptions {
  quietMs?: number;
  maxWaitMs?: number;
}

export function createInvalidationBatcher(
  client: QueryClient,
  options: BatcherOptions = {},
): InvalidationBatcher {
  const quietMs = options.quietMs ?? INVALIDATION_QUIET_MS;
  const maxWaitMs = options.maxWaitMs ?? INVALIDATION_MAX_WAIT_MS;
  const pending = new Map<string, QueryKey>();
  const dirty = new Set<Query>();
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  const clearTimers = () => {
    if (quietTimer !== null) clearTimeout(quietTimer);
    if (maxTimer !== null) clearTimeout(maxTimer);
    quietTimer = null;
    maxTimer = null;
  };

  const settleDirty = () => {
    for (const query of [...dirty]) {
      if (query.state.fetchStatus === "fetching") continue;
      dirty.delete(query);
      void client.invalidateQueries(
        { queryKey: query.queryKey, exact: true },
        { cancelRefetch: false },
      );
    }
    if (dirty.size === 0 && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  const markInFlight = (key: QueryKey | undefined) => {
    const fetching = client
      .getQueryCache()
      .findAll(key ? { queryKey: key, fetchStatus: "fetching" } : { fetchStatus: "fetching" });
    for (const query of fetching) dirty.add(query);
    if (dirty.size > 0 && !unsubscribe)
      unsubscribe = client.getQueryCache().subscribe((event) => {
        if (event.type === "updated" && dirty.has(event.query)) settleDirty();
        else if (event.type === "removed") dirty.delete(event.query);
      });
  };

  const refresh = (key: QueryKey | undefined) => {
    markInFlight(key);
    return client.invalidateQueries(key ? { queryKey: key } : undefined, { cancelRefetch: false });
  };

  const flush = () => {
    clearTimers();
    const keys = [...pending.values()];
    pending.clear();
    for (const key of keys) void refresh(key);
  };

  return {
    schedule(keys) {
      if (keys.length === 0) return;
      for (const key of keys) pending.set(keyId(key), key);
      if (quietTimer !== null) clearTimeout(quietTimer);
      quietTimer = setTimeout(flush, quietMs);
      if (maxTimer === null) maxTimer = setTimeout(flush, maxWaitMs);
    },
    async now(keys) {
      for (const key of keys) {
        pending.delete(keyId(key));
        for (const query of client.getQueryCache().findAll({ queryKey: key })) dirty.delete(query);
      }
      if (pending.size === 0) clearTimers();
      await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
    },
    everything() {
      pending.clear();
      clearTimers();
      void refresh(undefined);
    },
    dispose() {
      pending.clear();
      clearTimers();
      dirty.clear();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

const batchers = new WeakMap<QueryClient, InvalidationBatcher>();

export function invalidationBatcher(client: QueryClient): InvalidationBatcher {
  let batcher = batchers.get(client);
  if (!batcher) {
    batcher = createInvalidationBatcher(client);
    batchers.set(client, batcher);
  }
  return batcher;
}
