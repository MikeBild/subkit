import { canonicalBrowserPath } from "../../auth/browser-session.ts";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { getConfig } from "../../config/loader.ts";
import { tenants } from "../../db/schema/index.ts";
import type { AppEnv } from "../openapi.ts";
import { admitPersistentRateLimits, rateLimitBucketKey } from "../rate-limits/persistent.ts";

function unavailable(c: Context<AppEnv>) {
  return c.json(
    { code: "hosted_policy_unavailable", message: "Request admission is unavailable." },
    503,
  );
}

function refused(
  c: Context<AppEnv>,
  denial: { window: "minute" | "month"; retry_after_seconds: number },
) {
  c.header("Retry-After", String(denial.retry_after_seconds));
  return c.json(
    {
      code: denial.window === "month" ? "request_quota_exhausted" : "rate_limit_exceeded",
      message:
        denial.window === "month"
          ? "The monthly request allowance is exhausted."
          : "Too many requests. Try again shortly.",
    },
    429,
  );
}

function isMeteredPath(path: string): boolean {
  return path.startsWith("/v1/") || path === "/mcp" || path.startsWith("/mcp/");
}

const ACCOUNT_PATHS = new Set([
  "/v1/cockpit/bootstrap",
  "/v1/identity/memberships",
  "/v1/identity/tenant-session",
  "/v1/identity/owned-tenant",
  "/v1/identity/owned-tenant/deletion",
]);

export function hostedIngressRateLimit(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const config = getConfig();
    if (!config.auth.hosted.enabled || !isMeteredPath(canonicalBrowserPath(c.req.raw))) return next();
    const policy = config.server.hosted_rate_limit;
    if (policy.peer_per_minute <= 0 || policy.global_per_minute <= 0) return unavailable(c);
    const secret = config.auth.session.secret;
    const allowed = await admitPersistentRateLimits(
      [
        { bucket_key: rateLimitBucketKey(secret, "global", "http"), max: policy.global_per_minute },
        {
          bucket_key: rateLimitBucketKey(secret, "peer", c.get("client_ip") ?? "unknown"),
          max: policy.peer_per_minute,
        },
      ],
      c.get("db"),
    );
    if (!allowed.allowed) return refused(c, allowed);
    c.set("hosted_ingress_admitted", true);
    return next();
  };
}

export function hostedTenantRateLimit(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!isMeteredPath(canonicalBrowserPath(c.req.raw))) return next();
    const principal = c.get("principal");
    if (!principal) return next();
    const [tenant] = await c
      .get("db")
      .select({ origin: tenants.origin })
      .from(tenants)
      .where(eq(tenants.id, principal.tenant_id))
      .limit(1);
    if (!tenant) return unavailable(c);
    if (tenant.origin !== "self_service") return next();
    const config = getConfig();
    const max = config.server.hosted_rate_limit.tenant_per_minute;
    const monthlyMetered = !ACCOUNT_PATHS.has(canonicalBrowserPath(c.req.raw));
    if (
      max <= 0 ||
      (monthlyMetered && config.server.hosted_rate_limit.tenant_per_month <= 0) ||
      config.server.hosted_rate_limit.global_per_minute <= 0 ||
      config.server.hosted_rate_limit.principal_per_minute <= 0
    )
      return unavailable(c);
    const allowed = await admitPersistentRateLimits(
      [
        ...(monthlyMetered
          ? [
              {
                bucket_key: rateLimitBucketKey(
                  config.auth.session.secret,
                  "tenant_month",
                  principal.tenant_id,
                ),
                max: config.server.hosted_rate_limit.tenant_per_month,
                window: "month" as const,
              },
            ]
          : []),
        ...(!c.get("hosted_ingress_admitted")
          ? [
              {
                bucket_key: rateLimitBucketKey(config.auth.session.secret, "global", "http"),
                max: config.server.hosted_rate_limit.global_per_minute,
              },
            ]
          : []),
        {
          bucket_key: rateLimitBucketKey(config.auth.session.secret, "tenant", principal.tenant_id),
          max,
        },
        {
          bucket_key: rateLimitBucketKey(
            config.auth.session.secret,
            "principal",
            JSON.stringify([principal.tenant_id, principal.kind, principal.id]),
          ),
          max: config.server.hosted_rate_limit.principal_per_minute,
        },
      ],
      c.get("db"),
    );
    if (!allowed.allowed) return refused(c, allowed);
    return next();
  };
}
