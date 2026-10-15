import { createTokenExchangeProvider } from "../auth/oauth/token-exchange.ts";
import { createApiKeyProvider } from "../auth/providers/api-key.ts";
import { AuthProviderRegistry } from "../auth/registry.ts";
import { isAuthDenial, type ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";

export async function resolveStdioPrincipal(
  db: Db,
  apiKey: string,
): Promise<ResolvedPrincipal | null> {
  const registry = new AuthProviderRegistry();
  registry.register(createTokenExchangeProvider({ db }));
  registry.register(createApiKeyProvider({ db }));
  const req = new Request("http://stdio.local/", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const resolved = await registry.resolve(req);
  return isAuthDenial(resolved) ? null : resolved;
}
