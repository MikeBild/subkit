// Materialized persona snapshot for the Ink REPL bridge.
//
// Persona resolution: prefer `/v1/sk/bootstrap` (one round-trip for the
// full UX-gating allow-set) and fall back to the legacy tier-filtered
// `whoami + rbac:can` fan-out for older engines. `loadBootstrap` owns
// the disk cache + 3-tier resolution.

import type { ResolvedProfile } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";
import { loadBootstrap, type SkBootstrapSnapshot } from "../lib/bootstrap.ts";
import type { PersonaProbe } from "../slash.ts";

export interface ResolvedPersona {
  label: string;
  probe: PersonaProbe;
  allowed: Set<string>;
  /** Tenant slug or uuid returned by whoami, preferred over the profile. */
  tenant: string | null;
  /** Email or sub returned by whoami — nice to show in the status line. */
  email: string | null;
  /** Wall-clock time the bootstrap snapshot was produced (ms).
   *  Surfaced in /status so an operator can see whether the
   *  cached allow-set is fresh or stale. */
  fetchedAt: number;
  /** Where the snapshot came from: network, disk cache, or the
   *  legacy tiered fallback. */
  source: "network" | "cache" | "fallback";
  /** Engine-resolved REPL/UI/notification prefs. */
  prefs: SkBootstrapSnapshot["prefs"];
}

export async function resolvePersona(
  client: EngineClient,
  profile: ResolvedProfile,
): Promise<ResolvedPersona> {
  const snap = await loadBootstrap(client, profile);
  return {
    label: snap.label,
    probe: snap.probe,
    allowed: snap.allowed,
    tenant: snap.tenant,
    email: snap.email,
    fetchedAt: snap.fetchedAt,
    source: snap.source,
    prefs: snap.prefs,
  };
}
