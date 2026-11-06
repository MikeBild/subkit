import { withNonRemovableScopes } from "../auth/scopes.ts";
import { type Config, ConfigSchema } from "./schema.ts";

function pinNonRemovableMcpScopes(cfg: Config): void {
  cfg.auth.mcp_oauth.scopes_supported = withNonRemovableScopes(cfg.auth.mcp_oauth.scopes_supported);
}

export function parseConfigDocument(document: unknown): Config {
  const parsed = ConfigSchema.parse(document);
  pinNonRemovableMcpScopes(parsed);
  return parsed;
}

export function safeParseConfigDocument(
  document: unknown,
): ReturnType<typeof ConfigSchema.safeParse> {
  const result = ConfigSchema.safeParse(document);
  if (result.success) pinNonRemovableMcpScopes(result.data);
  return result;
}
