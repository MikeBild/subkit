// MCP OAuth 2.1 Dynamic Client Registration: RFC 7591 POST /v1/oauth/register.
//
// Raw Hono handler — application/json body, not @hono/zod-openapi.
// Precedent: the raw /mcp mount in mcp/transports/streamable-http.ts.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import {
  AuditAction,
  auditAwait,
  readRequestSource,
  SYSTEM_TENANT_ID,
} from "../../../audit/index.ts";
import { createMcpOAuthProvider } from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import { logger } from "../../../logging/index.ts";
import type { AppEnv } from "../../openapi.ts";

// ── Per-IP rate limiter for DCR ─────────────────────────────────────────
// Max 10 registrations per IP per 60s. Checked before any DB work.
const DCR_MAX = 10;
const DCR_WINDOW_MS = 60_000;
const DCR_BUCKET_CAP = 10_000;
interface DcrBucket {
  count: number;
  resetAt: number;
}

export function registerOAuthDcrRoutes(app: OpenAPIHono<AppEnv>): void {
  // Bucket map is scoped to this registration call so each app instance
  // (e.g. per-test server) gets its own independent rate-limit state.
  const dcrBuckets = new Map<string, DcrBucket>();

  function checkDcrRateLimit(ip: string): boolean {
    const now = Date.now();
    const bucket = dcrBuckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      // Before inserting a new entry, prune expired buckets if the map is full.
      if (!bucket && dcrBuckets.size >= DCR_BUCKET_CAP) {
        for (const [key, b] of dcrBuckets) {
          if (b.resetAt <= now) dcrBuckets.delete(key);
        }
      }
      dcrBuckets.set(ip, { count: 1, resetAt: now + DCR_WINDOW_MS });
      return true;
    }
    if (bucket.count >= DCR_MAX) return false;
    bucket.count += 1;
    return true;
  }

  // ── RFC 7591 Dynamic Client Registration ───────────────────────────────────
  app.post("/v1/oauth/register", async (c) => {
    // Per-IP rate limit — checked before any DB work.
    // Only applied when the IP is identifiable; if neither x-forwarded-for
    // nor x-real-ip is present the request came from a trusted reverse-proxy
    // setup without forwarding or from a test harness — skip the limit.
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? null;
    if (ip !== null && !checkDcrRateLimit(ip)) {
      // A 429 here is security-relevant (scanning / abuse) — persist it.
      await auditAwait(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          action: AuditAction.MCP_OAUTH_DCR_RATE_LIMITED,
          resource_type: "mcp_oauth_client",
          resource_id: null,
          result: "denied",
          metadata: {
            request_source: readRequestSource(c),
            reason: "rate_limited",
            ip,
          },
        },
        c.get("db"),
      );
      return c.json({ error: "too_many_requests", error_description: "rate limit exceeded" }, 429);
    }

    let dynamicEnabled = true;
    try {
      dynamicEnabled = getConfig().auth.mcp_oauth.dynamic_registration_enabled;
    } catch {
      /* not yet loaded */
    }
    if (!dynamicEnabled) {
      return c.json({ error: "registration_not_supported" }, 400);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json(
        { error: "invalid_client_metadata", error_description: "invalid JSON body" },
        400,
      );
    }

    // Redirect URI allowlist: https://, http://localhost, http://127.0.0.1,
    // or private-use scheme (URI does not start with http:// to a public host).
    // Rejects plaintext http:// to public hosts.
    const safeRedirectUri = z
      .string()
      .max(2048)
      .refine(
        (uri) => {
          // Pseudo-schemes that can carry executable payloads are never
          // valid redirect targets, regardless of how they parse.
          const lower = uri.trim().toLowerCase();
          for (const scheme of ["javascript:", "data:", "vbscript:", "file:", "blob:"]) {
            if (lower.startsWith(scheme)) return false;
          }
          try {
            const u = new URL(uri);
            if (u.protocol === "https:") return true;
            if (u.protocol === "http:") {
              return u.hostname === "localhost" || u.hostname === "127.0.0.1";
            }
            // Private-use / custom schemes (e.g. myapp://) are allowed
            return !u.protocol.startsWith("http");
          } catch {
            // Non-parseable URIs with custom schemes (e.g. myapp://callback) — allow
            // only if the string contains "://" (has a scheme) and is not http to
            // a public host. Scheme-less strings like "not-a-url" are rejected.
            if (!uri.includes("://")) return false;
            return (
              !uri.startsWith("http://") ||
              uri.startsWith("http://localhost") ||
              uri.startsWith("http://127.0.0.1")
            );
          }
        },
        {
          message:
            "redirect_uri must be https, http://localhost, http://127.0.0.1, or a private-use scheme",
        },
      );

    const parsed = z
      .object({
        redirect_uris: z.array(safeRedirectUri).min(1).max(5),
        client_name: z.string().max(255).optional(),
        grant_types: z.array(z.string()).optional(),
        token_endpoint_auth_method: z.string().optional(),
        scope: z.string().optional(),
        software_id: z.string().max(255).optional(),
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: "invalid_client_metadata",
          error_description: parsed.error.issues.map((i) => i.message).join("; "),
        },
        400,
      );
    }

    const db = c.get("db");
    const provider = createMcpOAuthProvider({ db, config: getConfig() });

    try {
      const result = await provider.registerClient({
        ...parsed.data,
        requestSource: readRequestSource(c) ?? "api",
      });
      // `registration_client_uri` is intentionally omitted: subkit does not
      // serve the RFC 7591 client-configuration endpoint, and advertising a
      // URL with no handler is worse than not advertising it.
      return c.json(
        {
          ...result,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        },
        201,
      );
    } catch (err) {
      const oauthError = (err as { oauth_error?: string }).oauth_error;
      logger.error({
        module: "mcp_oauth",
        action: "register.failed",
        msg: "client registration failed",
        error: err instanceof Error ? err.message : String(err),
      });
      await auditAwait(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          action: AuditAction.OAUTH_CLIENT_REGISTRATION_FAILED,
          resource_type: "mcp_oauth_client",
          resource_id: null,
          result: "error",
          metadata: {
            request_source: readRequestSource(c),
            error: err instanceof Error ? err.message : String(err),
          },
        },
        db,
      );
      if (oauthError) {
        return c.json({ error: oauthError }, 400);
      }
      return c.json({ error: "server_error" }, 500);
    }
  });
}
