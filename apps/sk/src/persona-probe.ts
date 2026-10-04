// Built-in persona vocabulary for `sk --help` gating and the persona
// hint `sk login` caches on the profile. UX-only: the engine enforces
// every permission regardless.

import { saveProfile } from "./config.ts";
import type { EngineClient } from "./engine-client.ts";

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
  "system:restart": 4,
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
    // Unreachable engine — leave unset.
  }
}
