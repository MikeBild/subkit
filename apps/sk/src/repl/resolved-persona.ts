import type { ResolvedProfile } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";
import { loadBootstrap, type SkBootstrapSnapshot, unresolvedSnapshot } from "../lib/bootstrap.ts";
import type { PersonaProbe } from "../slash.ts";

export interface ResolvedPersona {
  label: string;
  probe: PersonaProbe;
  allowed: Set<string>;
  tenant: string | null;
  email: string | null;
  fetchedAt: number;
  source: "network" | "cache" | "fallback";
  prefs: SkBootstrapSnapshot["prefs"];
}

export function fallbackPersona(profile: ResolvedProfile): ResolvedPersona {
  return personaFromSnapshot(unresolvedSnapshot(profile, Date.now()));
}

export async function resolvePersona(
  client: EngineClient,
  profile: ResolvedProfile,
): Promise<ResolvedPersona> {
  return personaFromSnapshot(await loadBootstrap(client, profile));
}

function personaFromSnapshot(snap: SkBootstrapSnapshot): ResolvedPersona {
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
