import { SYSTEM_TENANT_ID } from "../audit/types.ts";

const DEFAULT_CAPACITY_FROM_ENV = (): number => envInt("SUBKIT_LOG_RING_SIZE", 10_000);

export interface CapturedLog {
  ts: number;
  level: string;
  module?: string | undefined;
  action?: string | undefined;
  msg?: string | undefined;
  fields: Record<string, unknown>;
}

const SYSTEM_TENANT_TOKENS = new Set<string>([SYSTEM_TENANT_ID, "", "system"]);

function entryTenantId(entry: CapturedLog): string | null {
  const v = entry.fields?.tenant_id;
  if (typeof v !== "string") return null;
  return v;
}

export function isEntryVisibleToTenant(
  entry: CapturedLog,
  principal_tenant_id: string,
  includeEngine: boolean,
): boolean {
  const t = entryTenantId(entry);
  if (t === null || SYSTEM_TENANT_TOKENS.has(t)) return includeEngine;
  return includeEngine || t === principal_tenant_id;
}

interface LogRing {
  record(entry: CapturedLog): void;
  tail(opts?: {
    since_ms?: number;
    limit?: number;
    module?: string;
    action?: string;
    min_level?: string;
    visible_to_tenant?: string;
    include_engine?: boolean;
  }): CapturedLog[];
  size(): number;
  capacity(): number;
  clear(): void;
  subscribe(handler: (entry: CapturedLog) => void): () => void;
}

export { logLevelWeight as levelWeight } from "@cli-core/log-levels.ts";

import { logLevelWeight } from "@cli-core/log-levels.ts";
import { envInt } from "../env.ts";

function weight(level: string): number {
  return logLevelWeight(level);
}

export function pageEndingOnMillisecondBoundary(
  chronological: CapturedLog[],
  limit: number,
): CapturedLog[] {
  const lastTs = chronological[limit - 1]?.ts;
  if (lastTs === undefined) return chronological;
  const boundaryIndex = chronological.findIndex(
    (entry, index) => index >= limit && entry.ts !== lastTs,
  );
  return boundaryIndex === -1 ? chronological : chronological.slice(0, boundaryIndex);
}

export function createLogRing(capacity = DEFAULT_CAPACITY_FROM_ENV()): LogRing {
  const buf: CapturedLog[] = [];
  const subs = new Set<(e: CapturedLog) => void>();

  const matches = (e: CapturedLog, opts: NonNullable<Parameters<LogRing["tail"]>[0]>): boolean => {
    if (opts.since_ms !== undefined && e.ts < opts.since_ms) return false;
    if (opts.module && e.module !== opts.module) return false;
    if (opts.action && e.action !== opts.action) return false;
    if (opts.min_level && weight(e.level) < weight(opts.min_level)) return false;
    if (
      opts.visible_to_tenant !== undefined &&
      !isEntryVisibleToTenant(e, opts.visible_to_tenant, opts.include_engine === true)
    )
      return false;
    return true;
  };

  return {
    record(entry: CapturedLog): void {
      buf.push(entry);
      while (buf.length > capacity) buf.shift();
      if (subs.size > 0) {
        for (const sub of subs) {
          try {
            sub(entry);
          } catch {}
        }
      }
    },
    tail(opts = {}): CapturedLog[] {
      const limit = opts.limit ?? 200;
      const filtered = buf.filter((e) => matches(e, opts));
      if (opts.since_ms !== undefined) return pageEndingOnMillisecondBoundary(filtered, limit);
      return filtered.slice(-limit).reverse();
    },
    size(): number {
      return buf.length;
    },
    capacity(): number {
      return capacity;
    },
    clear(): void {
      buf.length = 0;
    },
    subscribe(handler): () => void {
      subs.add(handler);
      return () => {
        subs.delete(handler);
      };
    },
  };
}

export const logRing: LogRing = createLogRing();
