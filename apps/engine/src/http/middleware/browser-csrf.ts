import { z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import {
  browserSessionForPrincipal,
  canonicalBrowserPath,
  verifyBrowserCsrf,
} from "../../auth/browser-session.ts";
import type { AppEnv } from "../openapi.ts";

const CsrfHeaderSchema = z.string().min(1).max(4096);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const EXEMPT_PREFIXES = [
  "/v1/identity/login/",
  "/v1/identity/invites/redeem",
  "/v1/identity/invites/preview",
  "/v1/identity/invites/login",
  "/v1/identity/onboarding",
  "/v1/oauth/",
  "/v1/tool-approvals/",
  "/v1/setup",
];
const GRANT_FORM_PATHS = [
  /^\/v1\/connectors\/[^/]+\/credentials\/setup$/,
  /^\/v1\/connector-drafts\/[^/]+\/credentials\/setup$/,
];

function isExempt(path: string, method: string): boolean {
  return (
    (method === "POST" && path === "/v1/identity/recovery/login") ||
    EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    (method === "POST" && GRANT_FORM_PATHS.some((pattern) => pattern.test(path)))
  );
}

export function browserCsrfMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    const path = canonicalBrowserPath(c.req.raw);
    if (!MUTATING_METHODS.has(c.req.method) || isExempt(path, c.req.method)) {
      return await next();
    }

    const payload = await browserSessionForPrincipal(c.req.raw, principal);
    if (!payload) return await next();

    const fetchSite = c.req.header("sec-fetch-site");
    if (fetchSite === "cross-site") {
      return c.json(
        { code: "csrf_rejected", message: "cross-site browser writes are not allowed" },
        403,
      );
    }

    const parsed = CsrfHeaderSchema.safeParse(c.req.header("x-subkit-csrf"));
    if (!parsed.success || !(await verifyBrowserCsrf(parsed.data, payload))) {
      return c.json(
        { code: "csrf_rejected", message: "a valid X-Subkit-CSRF header is required" },
        403,
      );
    }
    return await next();
  };
}
