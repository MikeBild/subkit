// React hook that exposes the bootstrap snapshot reactively.
//
// Replaces the blocking `await resolvePersonaShared(...)` gate at REPL
// startup with a non-blocking hook: render the welcome banner first,
// resolve persona in the background, push a toast on completion. The
// snapshot is materialized via `loadBootstrap` (cache → /v1/sk/bootstrap
// → tiered persona-probe), so the first frame is no longer held up
// by the network.

import { createHash } from "node:crypto";
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

  // R5-W2: depend on a stable bootstrap KEY rather than the
  // `client` / `profile` *references*. A parent that re-creates
  // EngineClient (e.g. on token rotation, or a remount) used to
  // re-fire the effect with no token-fingerprint check at the hook
  // layer; the disk cache absorbed it but `loading` flipped back to
  // true and the persona-aware UI grayed out for a frame. The key
  // is identical whenever (engine_url, tenant, fingerprint(api_key))
  // matches — same identity that drives `bootstrapCachePath`.
  const apiKeyFp = createHash("sha256")
    .update(profile.api_key ?? "")
    .digest("hex")
    .slice(0, 16);
  const bootstrapKey = `${profile.engine_url}|${profile.active_tenant_id ?? ""}|${apiKeyFp}`;

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
    // The effect intentionally depends on `bootstrapKey` (a stable
    // hash of the credential set) rather than `client`/`profile`
    // identity. `client` and `profile` are still read inside the
    // effect — they're closed over fresh from the latest render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapKey, cacheDir, cacheTtlMs, forceRefresh, now]);

  return { snapshot, loading, error };
}
