// Identity login routes — pass-2 A1.
//
// Thin wrappers that delegate to `createOidcProvider()`. The provider
// owns every bit of state management (PKCE, sessions table, cookies,
// audit) — these routes just instantiate a provider bound to the
// per-request db and forward the raw Request.
//
// The routes are mounted OUTSIDE of `authMiddleware`'s require-auth
// guarantee because they bootstrap the session. The middleware allows
// unauthenticated requests through to them by design.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createOidcProvider } from "../../../auth/providers/oidc.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerLoginRoutes(app: OpenAPIHono<AppEnv>): void {
  app.get("/v1/identity/login/start", async (c) => {
    const provider = createOidcProvider({ db: c.get("db") });
    if (!provider.startLogin) {
      return c.json({ code: "not_supported", message: "oidc.startLogin missing" }, 500);
    }
    return provider.startLogin(c.req.raw);
  });

  app.get("/v1/identity/login/callback", async (c) => {
    const provider = createOidcProvider({ db: c.get("db") });
    if (!provider.finishLogin) {
      return c.json({ code: "not_supported", message: "oidc.finishLogin missing" }, 500);
    }
    return provider.finishLogin(c.req.raw);
  });

  app.post("/v1/identity/logout", async (c) => {
    const provider = createOidcProvider({ db: c.get("db") });
    if (!provider.revoke) {
      return c.json({ code: "not_supported", message: "oidc.revoke missing" }, 500);
    }
    return provider.revoke(c.req.raw);
  });
}
