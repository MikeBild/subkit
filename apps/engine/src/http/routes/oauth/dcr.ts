import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import {
  AuditAction,
  auditAwait,
  readRequestSource,
  SYSTEM_TENANT_ID,
} from "../../../audit/index.ts";
import { createMcpOAuthProvider, McpClientAdmissionError } from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import { logger } from "../../../logging/index.ts";
import type { AppEnv } from "../../openapi.ts";

const DCR_MAX = 10;
const DCR_WINDOW_MS = 60_000;
const DCR_BUCKET_CAP = 10_000;
const DCR_ISSUE_MESSAGES_MAX = 5;
interface DcrBucket {
  count: number;
  resetAt: number;
}

export function registerOAuthDcrRoutes(app: OpenAPIHono<AppEnv>): void {
  const dcrBuckets = new Map<string, DcrBucket>();

  function checkDcrRateLimit(ip: string): boolean {
    const now = Date.now();
    const bucket = dcrBuckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
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

  app.post("/v1/oauth/register", async (c) => {
    const ip = c.get("client_ip") ?? "unknown";
    if (!checkDcrRateLimit(ip)) {
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
    } catch {}
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

    const safeRedirectUri = z
      .string()
      .max(2048)
      .refine(
        (uri) => {
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
            return !u.protocol.startsWith("http");
          } catch {
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
        client_uri: z
          .string()
          .max(2048)
          .url()
          .refine(
            (uri) => {
              const u = new URL(uri);
              return (
                u.protocol === "https:" ||
                (u.protocol === "http:" &&
                  (u.hostname === "localhost" || u.hostname === "127.0.0.1"))
              );
            },
            { message: "client_uri must be https or http://localhost" },
          )
          .optional(),
        grant_types: z.array(z.string().max(128)).max(10).optional(),
        token_endpoint_auth_method: z.string().max(64).optional(),
        scope: z.string().max(2048).optional(),
        software_id: z.string().max(255).optional(),
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: "invalid_client_metadata",
          error_description: parsed.error.issues
            .slice(0, DCR_ISSUE_MESSAGES_MAX)
            .map((i) => i.message)
            .join("; "),
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
        registration_peer: c.get("client_ip") ?? "unknown",
      });
      return c.json(
        {
          ...result,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        },
        201,
      );
    } catch (err) {
      if (err instanceof McpClientAdmissionError) {
        if (err.retry_after_seconds) c.header("Retry-After", String(err.retry_after_seconds));
        return c.json(
          {
            error: err.reason === "rate" ? "too_many_requests" : "temporarily_unavailable",
            error_description: err.message,
          },
          err.reason === "rate" ? 429 : 503,
        );
      }
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
