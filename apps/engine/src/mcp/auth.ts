// Shared auth helper for the MCP server.
//
// The HTTP transport piggy-backs on the Hono `authMiddleware` — by the time
// a request reaches `/mcp`, a principal has already been resolved and
// attached to the context (or the request has been rejected with 401).
// This helper just pulls the principal back out of `c.var` so the mount
// code can pass it into the server factory.
//
// The stdio transport re-resolves the principal from an env-sourced api
// key once at boot, then reuses it for the life of the process.

import { createTokenExchangeProvider } from "../auth/oauth/token-exchange.ts";
import { createApiKeyProvider } from "../auth/providers/api-key.ts";
import { AuthProviderRegistry } from "../auth/registry.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";

export async function resolveStdioPrincipal(
  db: Db,
  apiKey: string,
): Promise<ResolvedPrincipal | null> {
  const registry = new AuthProviderRegistry();
  // stdio accepts the same two machine credentials as HTTP: an exchanged
  // token or the key itself.
  registry.register(createTokenExchangeProvider({ db }));
  registry.register(createApiKeyProvider({ db }));
  // Build a synthetic Request so the api-key provider sees the token.
  const req = new Request("http://stdio.local/", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  return registry.resolve(req);
}
