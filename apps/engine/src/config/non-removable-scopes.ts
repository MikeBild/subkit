// Scopes the MCP authorization server may never stop advertising.
//
// `auth.mcp_oauth.scopes_supported` is a configurable leaf, and a RUNNING
// installation does not ride the schema default: its settings document carries
// an explicit list, persisted by an earlier settings write, and an explicit
// value beats a default forever. So 6.33.0 extended the default, every test
// that read the default passed, and the droplet — engine reporting 6.33.0 —
// went on serving the three scopes its document was pinned to. `metrics:read`
// was enforced on `/metrics` and offerable nowhere: a person connecting a
// monitoring system had no box to tick, which is the whole thing the scope
// exists for.
//
// A scope this server ENFORCES has to be one a person can be OFFERED, or the
// route is closed to connections by construction. That is not a preference an
// installation gets to configure away. Every document that becomes the running
// configuration passes through `config/loader.ts`, and every one of those
// paths calls this — the config file, a PostgreSQL revision, a single-leaf
// settings write. Operators keep the rest of the leaf: they may add, reorder
// and remove anything else, their order is preserved, and a missing
// non-removable scope is appended rather than replacing what they wrote.

import { withNonRemovableScopes } from "../auth/scopes.ts";
import { type Config, ConfigSchema } from "./schema.ts";

export function pinNonRemovableMcpScopes(cfg: Config): void {
  cfg.auth.mcp_oauth.scopes_supported = withNonRemovableScopes(cfg.auth.mcp_oauth.scopes_supported);
}

/**
 * Parse a configuration document into the shape the process will run on.
 *
 * The pin lives behind the parse rather than beside its call sites so that
 * "this document became the running configuration" and "the non-removable
 * scopes are in it" cannot come apart: a future third parse site gets the
 * guarantee by using this function, and reviewing a bare `ConfigSchema.parse`
 * in the loader is enough to notice one that does not.
 */
export function parseConfigDocument(document: unknown): Config {
  const parsed = ConfigSchema.parse(document);
  pinNonRemovableMcpScopes(parsed);
  return parsed;
}

/** `parseConfigDocument`, non-throwing — pins only on success. */
export function safeParseConfigDocument(
  document: unknown,
): ReturnType<typeof ConfigSchema.safeParse> {
  const result = ConfigSchema.safeParse(document);
  if (result.success) pinNonRemovableMcpScopes(result.data);
  return result;
}
