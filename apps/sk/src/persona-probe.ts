// Persona resolution shared between the readline REPL (`repl.ts`) and
// the Ink REPL (`ink-repl.ts`). Both used to issue ~22 RBAC probes
// against the engine on every session start, and the duplication
// (each REPL has its own copy of the loop) doubled the audit-log
// noise to ~44 `policy.denied` rows for non-admin members. Engine
// enforces all permissions anyway, so probing is purely UX gating —
// short-circuit on the role_name returned by `whoami` whenever
// possible.
//
// Tiers must stay in sync with `PERSONA_LEVEL` / `PERM_TIER` in
// `apps/sk/src/index.ts`.

import type { ResolvedProfile } from "./config.ts";
import type { EngineClient } from "./engine-client.ts";
import type { PersonaProbe } from "./slash.ts";

/** Permissions worth probing per tier. Lower tiers only probe their
 *  own tier's permissions; higher tiers also probe everything below.
 *  This means a `member` role probes 12 perms instead of 22, and a
 *  `portal` / `enduser` role probes 4 (not 22). */
const TIER_PERMISSIONS: Record<number, readonly string[]> = {
  1: ["conversation:read", "conversation:write", "memory:write"],
  2: ["conversation:approve", "conversation:list", "mcp:read", "skill:read"],
  3: [
    "conversation:cancel",
    "conversation:commit",
    "workflow:read",
    "workflow:write",
    "connector:read",
    "skill:write",
    "execution:read",
    "notification:read",
  ],
  4: ["audit:read", "identity:read", "rbac:read", "api_key:read", "portal_token:read"],
};

const ROLE_TIER: Record<string, number> = {
  admin: 4,
  operator: 3,
  member: 2,
  portal: 1,
  enduser: 1,
  user: 1,
};

/** All probe permissions — preserved as a stable list for callers
 *  that still want to enumerate (eg. `/whoami`-style debug output).
 *  Returned in the same order as the pre-fix `PROBE_PERMISSIONS`
 *  literal so any existing test snapshots stay aligned. */
export const ALL_PROBE_PERMISSIONS: readonly string[] = Object.values(TIER_PERMISSIONS).flat();

/** Pick the subset of `ALL_PROBE_PERMISSIONS` worth probing for a
 *  given role_name. Unknown role names default to tier-1
 *  (conservative) — the engine still enforces, so over-conservative
 *  probing only hides commands from the help output, never grants
 *  access. */
export function probePermissionsForRole(roleName: string | null | undefined): readonly string[] {
  const tier = ROLE_TIER[(roleName ?? "user").toLowerCase()] ?? 1;
  const buckets: string[] = [];
  for (let t = 1; t <= tier; t++) {
    const bucket = TIER_PERMISSIONS[t];
    if (bucket) buckets.push(...bucket);
  }
  return buckets;
}

export interface ResolvedPersonaSnapshot {
  label: string;
  allowed: Set<string>;
  probe: PersonaProbe;
  /** Tenant slug or uuid returned by whoami, preferred over the profile. */
  tenant: string | null;
  /** Email or sub returned by whoami — surfaced in the status line. */
  email: string | null;
}

/** Resolve persona via `whoami` + a TIER-FILTERED set of `rbac:can`
 *  probes. Returns conservatively (label = profile hint, allowed set
 *  empty) on any error — the caller should still render. */
export async function resolvePersonaShared(
  client: EngineClient,
  profile: ResolvedProfile,
): Promise<ResolvedPersonaSnapshot> {
  const allowed = new Set<string>();
  let label = profile.persona_hint ?? "user";
  let tenant: string | null = profile.active_tenant_id ?? null;
  let email: string | null = null;
  try {
    const who = await client.whoami().catch(() => null);
    if (who) {
      email = who.email ?? null;
      tenant = who.tenant_slug ?? who.tenant_id ?? tenant;
      if (who.role_name) label = who.role_name;
      const subset = probePermissionsForRole(who.role_name);
      for (const p of subset) {
        try {
          const d = await client.rbacCan({ principal_id: who.id, permission: p });
          if (d.allow) allowed.add(p);
        } catch {
          /* ignore probe failures — engine enforces anyway */
        }
      }
      // Refine label only if probe results expand on what role_name
      // told us. Avoids churning the cached persona_hint when the
      // role grants every probed perm.
      if (allowed.has("audit:read")) label = "admin";
      else if (allowed.has("workflow:write") && allowed.has("connector:read")) label = "operator";
      else if (allowed.has("mcp:read") && allowed.has("skill:read")) label = "member";
      else if (!allowed.has("conversation:list") && allowed.has("conversation:write"))
        label = "portal";
      else if (allowed.has("conversation:write")) label = "enduser";
    }
  } catch {
    /* leave label as-is */
  }
  return {
    label,
    allowed,
    probe: { allows: (p: string) => allowed.has(p) },
    tenant,
    email,
  };
}
