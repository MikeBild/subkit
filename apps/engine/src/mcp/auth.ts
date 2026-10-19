import { createTokenExchangeProvider } from "../auth/oauth/token-exchange.ts";
import { createApiKeyProvider } from "../auth/providers/api-key.ts";
import { AuthProviderRegistry } from "../auth/registry.ts";
import { isAuthDenial, type ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { assertTenantActive, SelfServiceIdentityError } from "../identity/self-service.ts";

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
  if (!resolved || isAuthDenial(resolved)) return null;
  try {
    await assertTenantActive(resolved.tenant_id, db);
    return resolved;
  } catch (err) {
    if (!(err instanceof SelfServiceIdentityError)) throw err;
    return null;
  }
}
