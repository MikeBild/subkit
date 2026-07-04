// React hook that exposes the bootstrap snapshot reactively.
//
// Replaces the blocking `await resolvePersonaShared(...)` gate at REPL
// startup with a non-blocking hook: render the welcome banner first,
// resolve persona in the background, push a toast on completion. The
// snapshot is materialized via `loadBootstrap` (cache → /v1/sk/bootstrap
// → tiered persona-probe), so the first frame is no longer held up
// by the network.

import { useEffect, useRef, useState } from "react";
import type { ResolvedProfile } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";
import {
  type BootstrapOptions,
  fingerprintApiKey,
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
  // Stash the `now` callback in a ref so an inline lambda
  // from a parent doesn't re-fire the bootstrap effect every render.
  // The closed-over `nowRef.current` is read fresh inside the effect.
  const nowRef = useRef(opts?.now);
  nowRef.current = opts?.now;

  // Depend on a stable bootstrap KEY rather than the
  // `client` / `profile` *references*. A parent that re-creates
  // EngineClient (e.g. on token rotation, or a remount) used to
  // re-fire the effect with no token-fingerprint check at the hook
  // layer; the disk cache absorbed it but `loading` flipped back to
  // true and the persona-aware UI grayed out for a frame. The key
  // is identical whenever (engine_url, tenant, fingerprint(api_key))
  // matches — same identity that drives `bootstrapCachePath`.
  // Hash via the shared `fingerprintApiKey` helper so this
  // hook and `bootstrapCachePath` agree on what counts as the same
  // principal. A future bump (8 → 16 → 24 hex) lands in one place.
  const bootstrapKey = `${profile.engine_url}|${profile.active_tenant_id ?? ""}|${fingerprintApiKey(profile.api_key)}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const now = nowRef.current;
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
    // The effect intentionally depends only on `bootstrapKey` and the
    // primitive opts. `client`, `profile`, and `now` are read fresh
    // from the latest render via closure / ref so a parent that
    // re-creates EngineClient or passes an inline `now` lambda
    // doesn't re-fire the effect.
    // identity. `client` and `profile` are still read inside the
    // effect — they're closed over fresh from the latest render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapKey, cacheDir, cacheTtlMs, forceRefresh]);

  return { snapshot, loading, error };
}
