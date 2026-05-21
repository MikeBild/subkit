// MCP OAuth 2.1 token endpoints: POST /v1/oauth/token and POST /v1/oauth/revoke.
//
// Raw Hono handlers — application/x-www-form-urlencoded body per RFC 6749 / RFC 7009.
// Not @hono/zod-openapi. Bodies are still Zod-validated at the boundary per AGENTS.md.
// Precedent: the raw /mcp mount in mcp/transports/streamable-http.ts.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { readRequestSource } from "../../../audit/index.ts";
import { createMcpOAuthProvider } from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import { logger } from "../../../logging/index.ts";
import type { AppEnv } from "../../openapi.ts";
import { parseFormBody, RevokeRequestSchema, TokenRequestSchema } from "./shared.ts";

export function registerOAuthTokenRoutes(app: OpenAPIHono<AppEnv>): void {
  // ── Token endpoint ─────────────────────────────────────────────────────────
  // Raw handler — application/x-www-form-urlencoded body per RFC 6749
  // (also accepts application/json). Both paths are validated through
  // `TokenRequestSchema` so the request body is Zod-checked at the boundary.
  app.post("/v1/oauth/token", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    const rawBody = contentType.includes("application/x-www-form-urlencoded")
      ? Object.fromEntries(await parseFormBody(c.req.raw))
      : await c.req.json().catch(() => null);
    const parsed = TokenRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", error_description: "invalid token request body" },
        400,
      );
    }
    const body = parsed.data;

    const db = c.get("db");
    const provider = createMcpOAuthProvider({ db, config: getConfig() });

    if (body.grant_type === "authorization_code") {
      const { code, code_verifier: codeVerifier, redirect_uri: redirectUri, client_id } = body;
      if (!code || !codeVerifier || !redirectUri || !client_id) {
        return c.json(
          { error: "invalid_request", error_description: "missing required parameters" },
          400,
        );
      }
      try {
        const tokens = await provider.exchangeAuthorizationCode({
          code,
          codeVerifier,
          redirectUri,
          clientId: client_id,
          requestSource: readRequestSource(c) ?? "api",
        });
        return c.json(tokens, 200, { "Cache-Control": "no-store" });
      } catch (err) {
        const oauthError = (err as { oauth_error?: string }).oauth_error ?? "invalid_grant";
        logger.warn({
          module: "mcp_oauth",
          action: "token.exchange_failed",
          msg: "authorization code exchange failed",
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: oauthError }, 400, { "Cache-Control": "no-store" });
      }
    }

    if (body.grant_type === "refresh_token") {
      const { refresh_token: refreshToken, client_id, scope } = body;
      if (!refreshToken || !client_id) {
        return c.json(
          { error: "invalid_request", error_description: "missing required parameters" },
          400,
        );
      }
      try {
        const tokens = await provider.exchangeRefreshToken({
          refreshToken,
          clientId: client_id,
          scope,
          requestSource: readRequestSource(c) ?? "api",
        });
        return c.json(tokens, 200, { "Cache-Control": "no-store" });
      } catch (err) {
        const oauthError = (err as { oauth_error?: string }).oauth_error ?? "invalid_grant";
        logger.warn({
          module: "mcp_oauth",
          action: "token.refresh_failed",
          msg: "refresh token exchange failed",
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: oauthError }, 400, { "Cache-Control": "no-store" });
      }
    }

    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  // ── Revocation endpoint ────────────────────────────────────────────────────
  // Raw handler — application/x-www-form-urlencoded body per RFC 7009.
  app.post("/v1/oauth/revoke", async (c) => {
    const parsed = RevokeRequestSchema.safeParse(
      Object.fromEntries(await parseFormBody(c.req.raw)),
    );
    if (!parsed.success || !parsed.data.token) {
      return c.json({ error: "invalid_request", error_description: "token required" }, 400);
    }
    const token = parsed.data.token;

    const db = c.get("db");
    const provider = createMcpOAuthProvider({ db, config: getConfig() });
    // RFC 7009: always return 200 regardless of token validity
    await provider.revokeToken(token, readRequestSource(c) ?? "api").catch((err: unknown) => {
      logger.warn({
        module: "mcp_oauth",
        action: "revoke.failed",
        msg: "token revocation failed",
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.json({}, 200);
  });
}
