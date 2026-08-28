// Provider-neutral MCP browser login funnel.

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { z } from "zod";
import {
  browserSessionFromRequest,
  clearBrowserSessionCookie,
  createApiKeyProvider,
  createOidcProvider,
  isSafeBrowserRedirect,
  issueBrowserSession,
  revokeBrowserSession,
  verifyLoginState,
} from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import type { Db } from "../../../db/client.ts";
import type { AppEnv } from "../../openapi.ts";
import { parseFormBody } from "../oauth/shared.ts";
import {
  authHtmlResponse,
  renderApiKeyLogin,
  renderErrorPage,
  renderProviderChoice,
  resolveAuthLocale,
  SIGN_IN_FAILED_TITLE,
  STATE_ERROR_MESSAGE,
} from "../oauth/ui.ts";

const ApiKeyFormSchema = z.object({
  provider: z.string().min(1),
  login_state: z.string().min(1),
  api_key: z.string().min(1),
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

function providers() {
  return [...getConfig().auth.providers].sort(
    (left, right) => Number(left.protocol === "api_key") - Number(right.protocol === "api_key"),
  );
}

function oidcProviders(): OidcConfig[] {
  return providers().filter((provider): provider is OidcConfig => provider.protocol === "oidc");
}

function safeRedirect(raw: string): string | null {
  return isSafeBrowserRedirect(raw, getConfig().server.public_base_url) ? raw : null;
}

function wantsJson(c: Context<AppEnv>): boolean {
  return (c.req.header("accept") ?? "").includes("application/json");
}

// Browser GET errors render the shared HTML template; JSON stays reserved
// for clients that explicitly Accept: application/json.
function browserStateError(
  c: Context<AppEnv>,
  status: 400 | 404,
  code: string,
  retryHref = "/v1/identity/login/start",
): Response {
  if (wantsJson(c)) return c.json({ code }, status);
  return authHtmlResponse(
    renderErrorPage(SIGN_IN_FAILED_TITLE, STATE_ERROR_MESSAGE, retryHref),
    status,
  );
}

function oidcProvider(config: OidcConfig, db: Db) {
  return createOidcProvider({
    db,
    providerId: config.id,
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
      const state = existingState ?? "";
      const loginState = await verifyLoginState(state);
      const redirectTo = safeRedirect(String(loginState?.redirect_to ?? ""));
      if (!redirectTo) return browserStateError(c, 400, "invalid_state");
      const base = getConfig().server.public_base_url;
      const choices = providers().map((provider) => ({
        id: provider.id,
        protocol: provider.protocol,
        href: `${base}/v1/identity/login/start?provider=${encodeURIComponent(provider.id)}&login_state=${encodeURIComponent(state)}`,
      }));
      return choices.length
        ? authHtmlResponse(
            renderProviderChoice(choices, resolveAuthLocale(c.req.header("accept-language"))),
          )
        : c.json(
            { code: "login_not_configured", message: "no MCP login provider configured" },
            503,
          );
    }

    const state = existingState ?? "";
    const loginState = await verifyLoginState(state);
    if (!loginState) return browserStateError(c, 400, "invalid_state");
    const selected = providers().find((provider) => provider.id === selectedId);
    if (!selected) {
      return browserStateError(
        c,
        404,
        "provider_not_found",
        `/v1/identity/login/start?login_state=${encodeURIComponent(state)}`,
      );
    }

    if (selected.protocol === "api_key") {
      return authHtmlResponse(
        renderApiKeyLogin(
          "/v1/identity/login/start",
          selected.id,
          state,
          undefined,
          resolveAuthLocale(c.req.header("accept-language")),
        ),
      );
    }

    const redirectTo = safeRedirect(String(loginState.redirect_to ?? ""));
    if (!redirectTo) return browserStateError(c, 400, "invalid_state");
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
          resolveAuthLocale(c.req.header("accept-language")),
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

  const finishOidc = async (c: Context<AppEnv>) => {
    const state = c.req.query("state") ?? "";
    const providerId = state.includes(".") ? state.slice(0, state.indexOf(".")) : "";
    if (!providerId) return browserStateError(c, 400, "invalid_state");
    // An unknown provider prefix means the state cannot be ours — same
    // 400 invalid-state contract as every other malformed callback state.
    const selected = oidcProviders().find((provider) => provider.id === providerId);
    if (!selected) return browserStateError(c, 400, "provider_not_found");
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
