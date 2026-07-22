// Single source of truth for projecting a principal onto the audit
// `actor_type` taxonomy.
//
// The audit_log schema admits three actor_type values:
//   - "user"           — a human-backed identity or portal-token principal.
//   - "system_account" — a service account row with a principal id.
//   - "system"         — actor-less machine emit (cron sweeps, engine
//                        boot, migrations). Carries `actor_id: null`.
//
// Every HTTP / MCP / CLI emitter that resolves a `principal` MUST go
// through this helper so the mapping stays consistent. Without it, the
// inline `principal.kind === "user" ? "user" : "system_account"` pattern
// silently collapses to a binary that loses the "actor-less" bucket and
// invites drift if a future principal kind is introduced.
//
// Mirrors the shape of `request-source.ts` — a tiny, single-purpose
// projector that the audit barrel re-exports.

import type { AuditActorType } from "./types.ts";

/** Minimal principal shape — both `principal.kind` enums in the engine
 *  (HTTP `Principal`, MCP `McpPrincipal`) project onto this contract. */
export interface PrincipalLike {
  kind: "user" | "system_account";
}

/** Map a resolved principal onto the audit `actor_type` enum.
 *  Routes that never resolve a principal (cron sweeps, engine boot)
 *  must NOT call this helper — they pass `actor_type: "system"`
 *  directly and `actor_id: null`. */
export function actorType(principal: PrincipalLike): AuditActorType {
  return principal.kind === "user" ? "user" : "system_account";
}
