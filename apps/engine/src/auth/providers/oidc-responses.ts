import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import {
  authHtmlResponse,
  renderErrorPage,
  resolvePageLook,
  type SignInError,
} from "../../http/routes/oauth/ui.ts";
import { createMcpOAuthProvider } from "../oauth/server-provider.ts";

export const LOGIN_START_PATH = "/v1/identity/login/start";

function httpError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function wantsJson(req: Request): boolean {
  return (req.headers.get("accept") ?? "").includes("application/json");
}

export function browserError(
  req: Request,
  status: number,
  code: string,
  message: string,
  pageError: SignInError,
  retryHref: string,
): Response {
  if (wantsJson(req)) return httpError(status, code, message);
  return authHtmlResponse(
    renderErrorPage(pageError, retryHref, resolvePageLook(req.headers)),
    status,
  );
}

export function tenantMismatchResponse(req: Request): Response {
  return browserError(
    req,
    400,
    "tenant_mismatch",
    "tenant does not match configured sign-in target",
    "tenant_unavailable",
    LOGIN_START_PATH,
  );
}

export async function redirectDenialToClient(
  exec: Db,
  redirectTo: string | null,
): Promise<Response | null> {
  if (!redirectTo) return null;
  try {
    const authorizeUrl = new URL(redirectTo);
    if (!authorizeUrl.pathname.endsWith("/v1/oauth/authorize")) return null;
    const clientId = authorizeUrl.searchParams.get("client_id");
    const clientRedirect = authorizeUrl.searchParams.get("redirect_uri");
    if (!clientId || !clientRedirect) return null;
    const client = await createMcpOAuthProvider({ db: exec, config: getConfig() }).getClient(
      clientId,
    );
    if (!client?.redirect_uris.includes(clientRedirect)) return null;
    const target = new URL(clientRedirect);
    target.searchParams.set("error", "access_denied");
    const clientState = authorizeUrl.searchParams.get("state");
    if (clientState) target.searchParams.set("state", clientState);
    return new Response(null, {
      status: 302,
      headers: { location: target.toString(), "cache-control": "no-store" },
    });
  } catch {
    return null;
  }
}

export function isSafeRedirect(url: string, baseUrl: string): boolean {
  if (!url) return false;
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  try {
    const target = new URL(url);
    const base = new URL(baseUrl);
    return target.origin === base.origin;
  } catch {
    return false;
  }
}
