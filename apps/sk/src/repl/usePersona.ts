// React hook that exposes the bootstrap snapshot reactively.
//
// Replaces the blocking `await resolvePersonaShared(...)` gate at REPL
// startup with a non-blocking hook: render the welcome banner first,
// resolve persona in the background, push a toast on completion. The
// snapshot is materialized via `loadBootstrap` (cache → /v1/sk/bootstrap
// → tiered persona-probe), so the first frame is no longer held up
// by the network.

import { useEffect, useState } from "react";
import type { ResolvedProfile } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";
import {
  type BootstrapOptions,
  loadBootstrap,
  type SkBootstrapSnapshot,
} from "../lib/bootstrap.ts";

export interface UsePersonaResult {
  snapshot: SkBootstrapSnapshot | null;
  loading: boolean;
  error: string | null;
}

/**
 * Resolve the persona snapshot reactively.
 *
 * The hook returns a sentinel "user" snapshot synchronously so the
 * REPL can render its chrome immediately; the real allow-set arrives
 * once the bootstrap fetch resolves. Components that only render
 * persona-aware widgets should gate on `loading === false`.
 */
export function usePersona(
  client: EngineClient,
  profile: ResolvedProfile,
  opts?: BootstrapOptions,
): UsePersonaResult {
  const [snapshot, setSnapshot] = useState<SkBootstrapSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Read primitive opts off the bag rather than depending on the
  // object identity. If a parent passes `opts={ cacheTtlMs: 0 }` as
  // an inline literal, the object reference changes every render and
  // the effect would re-fire on every render — the cache stops
  // working and the engine is hammered. Reviewers caught this in W10.
  const cacheDir = opts?.cacheDir;
  const cacheTtlMs = opts?.cacheTtlMs;
  const forceRefresh = opts?.forceRefresh;
  const now = opts?.now;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const optsResolved: BootstrapOptions = {
          ...(cacheDir !== undefined ? { cacheDir } : {}),
          ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}),
          ...(forceRefresh !== undefined ? { forceRefresh } : {}),
          ...(now !== undefined ? { now } : {}),
        };
        const snap = await loadBootstrap(client, profile, optsResolved);
        if (cancelled) return;
        setSnapshot(snap);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, profile, cacheDir, cacheTtlMs, forceRefresh, now]);

  return { snapshot, loading, error };
}
