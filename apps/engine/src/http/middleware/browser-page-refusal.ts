import { retryAfterDeltaSeconds } from "@shared/backoff.ts";
import type { MiddlewareHandler } from "hono";
import { canonicalBrowserPath } from "../../auth/index.ts";
import { logger } from "../../logging/index.ts";
import { isBrowserNavigation, isBrowserPageRoute } from "../browser-pages.ts";
import type { AppEnv } from "../openapi.ts";
import { renderBrowserRefusalPage } from "../routes/browser-refusal-page.ts";
import { HTML_PAGE_HEADERS, NEGOTIATED_VARY, resolvePageLook } from "../routes/oauth/ui.ts";

async function refusalCode(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    return typeof body.code === "string" && /^[a-z0-9_]{1,64}$/.test(body.code)
      ? body.code
      : "request_refused";
  } catch {
    return "request_refused";
  }
}

export function browserPageRefusalMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const response = c.res;
    if (response.status < 400) return;
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) return;
    const path = canonicalBrowserPath(c.req.raw);
    if (!isBrowserPageRoute(c.req.method, path) || !isBrowserNavigation(c.req.raw.headers)) return;
    const code = await refusalCode(response);
    const retryAfter = response.headers.get("retry-after");
    const url = new URL(c.req.url);
    logger.info({
      module: "http",
      action: "browser_page.refusal_rendered",
      msg: "browser page refusal shown as a page instead of JSON",
      code,
      status: response.status,
      method: c.req.method,
      path,
    });
    const html = renderBrowserRefusalPage({
      look: resolvePageLook(c.req.raw.headers),
      code,
      status: response.status,
      retryAfterSeconds: retryAfterDeltaSeconds(retryAfter),
      reloadHref: c.req.method === "GET" ? `${url.pathname}${url.search}` : null,
    });
    c.res = undefined;
    c.res = new Response(html, {
      status: response.status,
      headers: {
        ...HTML_PAGE_HEADERS,
        vary: NEGOTIATED_VARY,
        ...(retryAfter ? { "retry-after": retryAfter } : {}),
      },
    });
  };
}
