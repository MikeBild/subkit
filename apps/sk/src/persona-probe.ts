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

import type { UX_GATING_PERMISSIONS, UxGatingPermission } from "@shared/ux-gating.ts";

import { type ResolvedProfile, saveProfile } from "./config.ts";
import type { EngineClient } from "./engine-client.ts";
import type { PersonaProbe } from "./slash.ts";

/** Permissions worth probing per tier. Lower tiers only probe their
 *  own tier's permissions; higher tiers also probe everything below.
 *  This means a `member` role probes 12 perms instead of 22, and a
 *  `portal` / `enduser` role probes 4 (not 22).
 *
 *  Each tier is typed as `UxGatingPermission[]`, where the union comes
 *  from `packages/shared/src/ux-gating.ts` — so a permission that is
 *  removed from the canonical list (or misspelled here) fails the
 *  typecheck immediately. The flattened union of all tiers does NOT
 *  have to equal `UX_GATING_PERMISSIONS` (the engine's set may be a
 *  proper superset of what the CLI's tiered probe optimises for), but
 *  every entry below MUST be a member of `UxGatingPermission`. The
 *  exhaustiveness assertion at the bottom of this file enforces that
 *  the *engine*'s canonical set fully covers the union of tiers
 *  below — the
 *  hand-written test only catches contains-mismatches at runtime. */
const TIER_PERMISSIONS: Record<number, readonly UxGatingPermission[]> = {
  1: ["conversation:read", "conversation:write", "memory:write"],
  2: ["conversation:approve", "conversation:list", "mcp:read", "skill:read"],
  3: [
    "conversation:cancel",
    "conversation:commit",
    "workflow:read",
    "workflow:write",
    "connector:read",
    "connector:write",
    "skill:write",
    "execution:read",
    "notification:read",
    "notification:write",
    "discovery:read",
    "file:read",
    "file:write",
    "file:delete",
  ],
  4: [
    "audit:read",
    "identity:read",
    "rbac:read",
    "api_key:read",
    "portal_token:read",
    "knowledge:read",
  ],
};

// Typecheck-time invariant: every permission below MUST be in the
// canonical engine list. If someone removes one from
// `@shared/ux-gating` and forgets here, this assignment fails to
// compile (the union narrows and the literal is no longer assignable).
type _AssertTiersAreSubset = readonly (typeof UX_GATING_PERMISSIONS)[number][];
const _ASSERT_TIERS_ARE_SUBSET: _AssertTiersAreSubset = Object.values(TIER_PERMISSIONS).flat();
void _ASSERT_TIERS_ARE_SUBSET;

const ROLE_TIER: Record<string, number> = {
  admin: 4,
  operator: 3,
  member: 2,
  portal: 1,
  enduser: 1,
  user: 1,
};

/** Permission → minimum persona tier that should SEE the command in
 *  `sk --help`. UX-only — the engine permission-checks every API call
 *  regardless. Lives here (not in index.ts) so the persona vocabulary
 *  has one home, and so tests can import it without pulling in the CLI
 *  entry module graph — importing `index.ts` from a test loads every
 *  command module ahead of the `mock.module()` calls other test files
 *  rely on, poisoning the shared worker's module cache. */
const PERM_TIER: Record<string, number> = {
  "audit:read": 4,
  "rbac:read": 4,
  "api_key:read": 4,
  "portal_token:read": 4,
  "identity:read": 4,
  "workflow:read": 3,
  "connector:read": 3,
  "connector:write": 3,
  "chat_workspace:read": 3,
  "credential:read": 3,
  "execution:read": 3,
  "notification:read": 3,
  "notification:write": 3,
  "discovery:read": 3,
  "subscription:read": 3,
  "inbound_hook:read": 3,
  "file:read": 1,
  "file:write": 1,
  "file:delete": 1,
  "mcp:read": 2,
  "skill:read": 2,
  "knowledge:read": 2,
  "conversation:write": 1,
};

/**
 * Should `sk --help` list a command for this persona?
 *
 * UX-only — the engine permission-checks every API call regardless, so a
 * mis-shown command fails cleanly at the gate, while a mis-HIDDEN one is
 * undiscoverable. That asymmetry is why an unknown persona fails OPEN:
 * `persona_hint` is absent on every profile created before the login probe
 * landed, and a custom RBAC role never maps to a built-in persona. Failing
 * closed there degraded EVERY such caller — admins included — to the
 * lowest tier and hid the whole authoring surface (`sk agent`,
 * `sk knowledge-sources`, `sk skills`, `sk learnings`) from the one command
 * users explore with.
 */
export function personaCanSee(
  hint: string | null | undefined,
  requires: string | undefined,
): boolean {
  if (!requires) return true;
  // Unknown / unset persona: show everything and let the engine gate.
  // (`user` is the unset placeholder tier, not a cacheable persona.)
  if (!hint || hint === "user" || ROLE_TIER[hint] === undefined) return true;
  return ROLE_TIER[hint] >= (PERM_TIER[requires] ?? 1);
}

/** Map an engine `whoami.role_name` to the persona `sk login` may cache on
 *  the profile, or `null` when the role is not a built-in persona (a custom
 *  RBAC role like "content-editor", or the `user` placeholder — which is the
 *  unset default, not a real role). Lives next to `ROLE_TIER` so the set of
 *  known persona names has one home; `sk --help` fails OPEN on `null`, so an
 *  unmapped role sees every command and the engine gates the call. */
export function personaHintForRole(
  roleName: string | null | undefined,
): "admin" | "operator" | "member" | "enduser" | "portal" | null {
  const role = roleName?.toLowerCase();
  if (!role || role === "user") return null;
  if (role === "admin" || role === "operator" || role === "member") return role;
  if (role === "enduser" || role === "portal") return role;
  return null;
}

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

/**
 * Record which built-in persona the freshly-authenticated key maps to, so
 * `sk --help` can tailor its command list (see `personaCanSee`). Called by
 * every `sk login` path. Best-effort by construction: the profile is already
 * saved and usable, so a failed or unreachable probe just leaves the hint
 * unset — which fails OPEN (full help) rather than hiding commands. A custom
 * RBAC role name matches no built-in persona and stays unset for the same
 * reason.
 */
export async function recordPersonaHint(
  client: EngineClient,
  profileName: string,
  engineUrl: string,
  apiKey: string,
  tenant: string | null,
): Promise<void> {
  try {
    const who = await client.whoami();
    const persona = personaHintForRole(who.role_name);
    if (!persona) return;
    saveProfile({
      name: profileName,
      engine_url: engineUrl,
      api_key: apiKey,
      active_tenant_id: tenant,
      persona_hint: persona,
    });
  } catch {
    // Unreachable engine / older engine without whoami — leave unset.
  }
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
