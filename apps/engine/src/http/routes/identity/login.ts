// Provider-neutral MCP browser login funnel.

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { z } from "zod";
import {
  browserSessionFromRequest,
  clearBrowserSessionCookie,
  createApiKeyProvider,
  createOidcProvider,
  createTokenBridgeProvider,
  isSafeBrowserRedirect,
  issueBrowserSession,
  revokeBrowserSession,
  signLoginState,
  verifyLoginState,
} from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import type { Db } from "../../../db/client.ts";
import type { AppEnv } from "../../openapi.ts";
import { parseFormBody } from "../oauth/shared.ts";
import { authHtmlResponse, renderApiKeyLogin, renderProviderChoice } from "../oauth/ui.ts";

const ApiKeyFormSchema = z.object({
  provider: z.string().min(1),
  login_state: z.string().min(1),
  api_key: z.string().min(1),
});

const BridgeFormSchema = z.object({
  login_state: z.string().min(1),
  identity_token: z.string().min(1),
});

type OidcConfig = {
  protocol: "oidc";
  id: string;
  label: string;
  issuer_url: string;
  client_id: string;
  client_secret: string;
  scopes: string;
  tenant_slug: string;
};

type TokenBridgeConfig = {
  protocol: "token_bridge";
  id: string;
  label: string;
  login_url: string;
  issuer_url: string;
  audience: string;
  jwks_url: string;
  tenant_slug: string;
  subject_claim: string;
  email_claim: string;
  email_verified_claim: string;
};

function providers() {
  return getConfig().auth.providers;
}

function oidcProviders(): OidcConfig[] {
  return providers().filter((provider): provider is OidcConfig => provider.protocol === "oidc");
}

function tokenBridgeProvider(id?: string): TokenBridgeConfig | undefined {
  return providers().find(
    (provider): provider is TokenBridgeConfig =>
      provider.protocol === "token_bridge" && (id === undefined || provider.id === id),
  );
}

function safeRedirect(raw: string): string | null {
  return isSafeBrowserRedirect(raw, getConfig().server.public_base_url) ? raw : null;
}

function oidcProvider(config: OidcConfig, db: Db) {
  return createOidcProvider({
    db,
    providerId: config.id,
    sessionAbsoluteTtlMs: 24 * 60 * 60 * 1000,
    issuerUrl: config.issuer_url,
    clientId: config.client_id,
    clientSecret: config.client_secret,
    scopes: config.scopes,
    redirectUri: `${getConfig().server.public_base_url}/v1/identity/login/callback`,
    tenantSlug: config.tenant_slug,
  });
}

export function registerLoginRoutes(app: OpenAPIHono<AppEnv>): void {
  app.get("/v1/identity/login/start", async (c) => {
    const selectedId = c.req.query("provider");
    const existingState = c.req.query("login_state");

    if (!selectedId) {
      const redirectTo = safeRedirect(c.req.query("redirect_to") ?? "");
      if (!redirectTo) {
        return c.json(
          { code: "invalid_redirect", message: "redirect_to must be same-origin" },
          400,
        );
      }
      const state = await signLoginState({ redirect_to: redirectTo });
      const base = getConfig().server.public_base_url;
      const choices = providers().map((provider) => ({
        id: provider.id,
        label: provider.label,
        href: `${base}/v1/identity/login/start?provider=${encodeURIComponent(provider.id)}&login_state=${encodeURIComponent(state)}`,
      }));
      return choices.length
        ? authHtmlResponse(renderProviderChoice(choices))
        : c.json(
            { code: "login_not_configured", message: "no MCP login provider configured" },
            503,
          );
    }

    const state = existingState ?? "";
    const loginState = await verifyLoginState(state);
    if (!loginState) return c.json({ code: "invalid_state" }, 400);
    const selected = providers().find((provider) => provider.id === selectedId);
    if (!selected) return c.json({ code: "provider_not_found" }, 404);

    if (selected.protocol === "api_key") {
      return authHtmlResponse(renderApiKeyLogin("/v1/identity/login/start", selected.id, state));
    }

    if (selected.protocol === "token_bridge") {
      const callbackState = await signLoginState({ ...loginState, provider_id: selected.id });
      const target = new URL(selected.login_url);
      target.searchParams.set(
        "mcp_callback",
        `${getConfig().server.public_base_url}/v1/identity/login/callback`,
      );
      target.searchParams.set("mcp_state", callbackState);
      return Response.redirect(target.toString(), 302);
    }

    const redirectTo = safeRedirect(String(loginState.redirect_to ?? ""));
    if (!redirectTo) return c.json({ code: "invalid_state" }, 400);
    const target = new URL(c.req.url);
    target.searchParams.set("redirect_to", redirectTo);
    const handler = oidcProvider(selected, c.get("db"));
    return handler.startLogin?.(new Request(target)) ?? c.json({ code: "not_supported" }, 500);
  });

  app.post("/v1/identity/login/start", async (c) => {
    const form = await parseFormBody(c.req.raw);
    const parsed = ApiKeyFormSchema.safeParse(Object.fromEntries(form));
    if (!parsed.success) return c.json({ code: "invalid_request" }, 400);
    const selected = providers().find(
      (provider) => provider.protocol === "api_key" && provider.id === parsed.data.provider,
    );
    if (!selected) return c.json({ code: "provider_not_found" }, 404);
    const loginState = await verifyLoginState(parsed.data.login_state);
    const redirectTo = safeRedirect(String(loginState?.redirect_to ?? ""));
    if (!redirectTo) return c.json({ code: "invalid_state" }, 400);
    const principal = await createApiKeyProvider({ db: c.get("db") }).resolve(
      new Request(c.req.url, { headers: { authorization: `Bearer ${parsed.data.api_key}` } }),
    );
    if (principal?.kind !== "user") {
      return authHtmlResponse(
        renderApiKeyLogin(
          "/v1/identity/login/start",
          selected.id,
          parsed.data.login_state,
          "The API key is invalid, expired, or is not owned by a user.",
        ),
        401,
      );
    }
    return issueBrowserSession({
      db: c.get("db"),
      tenantId: principal.tenant_id,
      userId: principal.id,
      redirectTo,
      via: "mcp_api_key",
      metadata: { api_key_id: principal.api_key_id, provider_id: selected.id },
    });
  });

  app.post("/v1/identity/login/callback", async (c) => {
    const form = await parseFormBody(c.req.raw);
    const parsed = BridgeFormSchema.safeParse(Object.fromEntries(form));
    if (!parsed.success) return c.json({ code: "invalid_request" }, 400);
    const loginState = await verifyLoginState(parsed.data.login_state);
    const selected = tokenBridgeProvider(String(loginState?.provider_id ?? ""));
    if (!selected) return c.json({ code: "provider_not_found" }, 404);
    const redirectTo = safeRedirect(String(loginState?.redirect_to ?? ""));
    if (!redirectTo) return c.json({ code: "invalid_state" }, 400);
    const principal = await createTokenBridgeProvider({
      db: c.get("db"),
      providerId: selected.id,
      issuer: selected.issuer_url,
      audience: selected.audience,
      jwksUrl: selected.jwks_url,
      tenantSlug: selected.tenant_slug,
      subjectClaim: selected.subject_claim,
      emailClaim: selected.email_claim,
      emailVerifiedClaim: selected.email_verified_claim,
    }).resolve(
      new Request(c.req.url, {
        headers: { authorization: `Bearer ${parsed.data.identity_token}` },
      }),
    );
    if (principal?.kind !== "user") {
      return c.json({ code: "access_denied", message: "identity login rejected" }, 403);
    }
    return issueBrowserSession({
      db: c.get("db"),
      tenantId: principal.tenant_id,
      userId: principal.id,
      redirectTo,
      via: "mcp_token_bridge",
      metadata: { provider_id: selected.id },
    });
  });

  const finishOidc = async (c: Context<AppEnv>) => {
    const state = c.req.query("state") ?? "";
    const providerId = state.includes(".") ? state.slice(0, state.indexOf(".")) : "";
    const selected = oidcProviders().find((provider) => provider.id === providerId);
    if (!selected) return c.json({ code: "provider_not_found" }, 404);
    const handler = oidcProvider(selected, c.get("db"));
    return handler.finishLogin?.(c.req.raw) ?? c.json({ code: "not_supported" }, 500);
  };
  app.get("/v1/identity/login/callback", finishOidc);

  app.post("/v1/identity/logout", async (c) => {
    const payload = await browserSessionFromRequest(c.req.raw);
    await revokeBrowserSession(c.get("db"), payload, "user_logout");
    return new Response(null, {
      status: 204,
      headers: { "set-cookie": clearBrowserSessionCookie(), "cache-control": "no-store" },
    });
  });
}
