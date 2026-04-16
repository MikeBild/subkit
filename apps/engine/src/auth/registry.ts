// AuthProviderRegistry — walks enabled providers in priority order per
// request and returns the first non-null Principal.

import { logger } from "../logging/logger.ts";
import type { AuthProvider, ResolvedPrincipal } from "./types.ts";

export class AuthProviderRegistry {
  private readonly providers: AuthProvider[] = [];

  register(provider: AuthProvider): this {
    this.providers.push(provider);
    return this;
  }

  list(): readonly AuthProvider[] {
    return this.providers;
  }

  /**
   * Walk providers in registration order and return the first non-null
   * principal. If every provider declines, returns null.
   */
  async resolve(req: Request): Promise<ResolvedPrincipal | null> {
    for (const p of this.providers) {
      try {
        const principal = await p.resolve(req);
        if (principal) return principal;
      } catch (err) {
        logger.error({
          module: "auth",
          action: "provider.error",
          msg: "auth provider threw while resolving",
          provider: p.name,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue to next provider — one bad provider shouldn't lock the
        // door. The error is logged but not surfaced as an auth grant.
      }
    }
    return null;
  }
}
