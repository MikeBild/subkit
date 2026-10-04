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

export function usePersona(
  client: EngineClient,
  profile: ResolvedProfile,
  opts?: BootstrapOptions,
): UsePersonaResult {
  const [snapshot, setSnapshot] = useState<SkBootstrapSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cacheDir = opts?.cacheDir;
  const cacheTtlMs = opts?.cacheTtlMs;
  const forceRefresh = opts?.forceRefresh;
  const nowRef = useRef(opts?.now);
  nowRef.current = opts?.now;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapKey, cacheDir, cacheTtlMs, forceRefresh]);

  return { snapshot, loading, error };
}
