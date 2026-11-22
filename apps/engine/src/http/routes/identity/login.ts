import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { z } from "zod";
import {
  accountChoiceCookie,
  browserSessionFromRequest,
  clearBrowserSessionCookieForRequest,
  createApiKeyProvider,
  createOidcProvider,
  isSafeBrowserRedirect,
  issueBrowserSession,
  oidcEndSessionUrl,
  revokeBrowserSession,
  signLoginState,
  verifyLoginState,
} from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import { isBrowserLoginProvider } from "../../../config/schema.ts";
import type { Db } from "../../../db/client.ts";
import {
  abandonPendingRegistration,
  clearPendingRegistrationCookie,
} from "../../../identity/index.ts";
import type { AppEnv } from "../../openapi.ts";
import { feedbackFormLink } from "../feedback-form-page.ts";
import { parseFormBody } from "../oauth/shared.ts";
import {
  authHtmlResponse,
  NEGOTIATED_VARY,
  negotiatedPageResponse,
  renderApiKeyLogin,
  renderErrorPage,
  renderProviderChoice,
  renderUnavailablePage,
  resolvePageLook,
  wantsHtmlPage,
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
  scopes: string;
  tenant_slug: string;
  product_id?: string | undefined;
  link_by_email?: boolean | undefined;
};

function providers() {
  return [...getConfig().auth.providers]
    .filter(isBrowserLoginProvider)
    .sort(
      (left, right) => Number(left.protocol === "api_key") - Number(right.protocol === "api_key"),
    );
}

const DEFAULT_LOGIN_REDIRECT = "/cockpit";

function oidcProviders(): OidcConfig[] {
  return providers().filter((provider): provider is OidcConfig => provider.protocol === "oidc");
}

function safeRedirect(raw: string): string | null {
  return isSafeBrowserRedirect(raw, getConfig().server.public_base_url) ? raw : null;
}

function wantsJson(c: Context<AppEnv>): boolean {
  return (c.req.header("accept") ?? "").includes("application/json");
}

function browserStateError(
  c: Context<AppEnv>,
  status: 400 | 404,
  code: string,
  retryHref = "/v1/identity/login/start",
): Response {
  if (wantsJson(c)) return c.json({ code }, status);
  return authHtmlResponse(
    renderErrorPage(
      code === "installation_login_requires_oidc" ? code : "state_expired",
      code === "installation_login_requires_oidc" ? "/cockpit" : retryHref,
      resolvePageLook(c.req.raw.headers),
    ),
    status,
  );
}

function oidcProvider(config: OidcConfig, db: Db, installationId?: string) {
  return createOidcProvider({
    db,
    providerId: config.id,
    issuerUrl: config.issuer_url,
    clientId: config.client_id,
    scopes: config.scopes,
    redirectUri: `${getConfig().server.public_base_url}/v1/identity/login/callback`,
    tenantSlug: config.tenant_slug,
    ...(config.product_id ? { productId: config.product_id } : {}),
    ...(config.link_by_email !== undefined ? { linkByEmail: config.link_by_email } : {}),
    ...(installationId ? { installationId } : {}),
  });
}

export function registerLoginRoutes(app: OpenAPIHono<AppEnv>): void {
  app.get("/v1/identity/login/start", async (c) => {
    const selectedId = c.req.query("provider");
    const existingState = c.req.query("login_state");
    const existingLoginState = await verifyLoginState(existingState ?? "");
    const installationId =
      typeof existingLoginState?.installation_id === "string"
        ? existingLoginState.installation_id
        : undefined;

    if (!selectedId) {
      const carried = safeRedirect(String(existingLoginState?.redirect_to ?? ""));
      const state = carried
        ? (existingState ?? "")
        : await signLoginState({ redirect_to: DEFAULT_LOGIN_REDIRECT });
      const base = getConfig().server.public_base_url;
      const choices = providers().map((provider) => ({
        id: provider.id,
        protocol: provider.protocol,
        label: provider.label,
        href: `${base}/v1/identity/login/start?provider=${encodeURIComponent(provider.id)}&login_state=${encodeURIComponent(state)}`,
      }));
      if (choices.length > 0) {
        const look = resolvePageLook(c.req.raw.headers);
        return authHtmlResponse(renderProviderChoice(choices, look, feedbackFormLink(look)));
      }
      return wantsHtmlPage(c.req.header("accept"))
        ? negotiatedPageResponse(
            renderUnavailablePage(resolvePageLook(c.req.raw.headers), "login"),
            503,
          )
        : c.json(
            { code: "login_not_configured", message: "no MCP login provider configured" },
            503,
            { vary: NEGOTIATED_VARY },
          );
    }

    const state = existingState ?? "";
    const loginState = existingLoginState;
    if (!loginState) return c.redirect("/v1/identity/login/start", 302);
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
      if (installationId) return browserStateError(c, 400, "installation_login_requires_oidc");
      return authHtmlResponse(
        renderApiKeyLogin(
          "/v1/identity/login/start",
          selected.id,
          state,
          undefined,
          resolvePageLook(c.req.raw.headers),
        ),
      );
    }

    const redirectTo = safeRedirect(String(loginState.redirect_to ?? ""));
    if (!redirectTo) return browserStateError(c, 400, "invalid_state");
    const target = new URL(c.req.url);
    target.searchParams.set("redirect_to", redirectTo);
    const handler = oidcProvider(selected, c.get("db"), installationId);
    const cookie = c.req.header("cookie");
    return (
      handler.startLogin?.(new Request(target, cookie ? { headers: { cookie } } : {})) ??
      c.json({ code: "not_supported" }, 500)
    );
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
      const look = resolvePageLook(c.req.raw.headers);
      return authHtmlResponse(
        renderApiKeyLogin(
          "/v1/identity/login/start",
          selected.id,
          parsed.data.login_state,
          apiKeyLoginRefusal(look.locale),
          look,
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
    const selected = oidcProviders().find((provider) => provider.id === providerId);
    if (!selected) return browserStateError(c, 400, "provider_not_found");
    const handler = oidcProvider(selected, c.get("db"));
    return handler.finishLogin?.(c.req.raw) ?? c.json({ code: "not_supported" }, 500);
  };
  app.get("/v1/identity/login/callback", finishOidc);

  app.post("/v1/identity/logout", async (c) => {
    const payload = await browserSessionFromRequest(c.req.raw);
    await revokeBrowserSession(c.get("db"), payload, "user_logout");
    const abandoned = await abandonPendingRegistration(c.req.raw, c.get("db"));
    const headers = new Headers({ "cache-control": "no-store" });
    headers.append("set-cookie", clearBrowserSessionCookieForRequest(c.req.raw));
    headers.append("set-cookie", clearPendingRegistrationCookie());
    const signedInWith = payload ? payload.login_provider : abandoned?.login_provider;
    const loginProvider = payload?.installation_id
      ? undefined
      : oidcProviders().find((provider) => provider.id === signedInWith);
    const endSessionUrl = loginProvider
      ? await oidcEndSessionUrl({
          issuerUrl: loginProvider.issuer_url,
          clientId: loginProvider.client_id,
          postLogoutRedirectUri: `${getConfig().server.public_base_url}${DEFAULT_LOGIN_REDIRECT}`,
        })
      : null;
    if (!endSessionUrl) {
      if (loginProvider || abandoned) headers.append("set-cookie", accountChoiceCookie(true));
      return new Response(null, { status: 204, headers });
    }
    return Response.json({ end_session_url: endSessionUrl }, { status: 200, headers });
  });
}

export function apiKeyLoginRefusal(locale: "de" | "en"): string {
  return locale === "de"
    ? "Dieser API-Schlüssel ist ungültig, abgelaufen oder gehört keiner Person. Mit dem Schlüssel eines Systemkontos meldet man sich nicht im Cockpit an."
    : "This API key is invalid, expired, or not owned by a person. A system account's key does not sign in to the Cockpit.";
}
