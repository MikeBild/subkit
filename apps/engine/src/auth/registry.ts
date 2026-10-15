import { logger } from "../logging/logger.ts";
import type { AuthDenial, RegisteredAuthProvider, ResolvedPrincipal } from "./types.ts";
import { isAuthDenial } from "./types.ts";

export class AuthProviderRegistry {
  private readonly providers: RegisteredAuthProvider[] = [];

  register(provider: RegisteredAuthProvider): this {
    this.providers.push(provider);
    return this;
  }

  list(): readonly RegisteredAuthProvider[] {
    return this.providers;
  }

  async resolve(req: Request): Promise<ResolvedPrincipal | AuthDenial | null> {
    for (const p of this.providers) {
      let claimed = false;
      try {
        claimed = "claims" in p ? p.claims(req) : false;
        const principal = await p.resolve(req);
        if (isAuthDenial(principal)) return principal;
        if (principal) return principal;
      } catch (err) {
        logger.error({
          module: "auth",
          action: "provider.error",
          msg: "auth provider threw while resolving",
          provider: p.name,
          error: err instanceof Error ? err.message : String(err),
        });
        if (claimed) return { denied: true, provider: p.name, reason: "provider_error" };
      }
    }
    return null;
  }
}
