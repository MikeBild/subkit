import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  authHtmlResponse,
  GRANT_DENIED_MESSAGE,
  renderConsentPage,
  renderErrorPage,
  renderProviderChoice,
  SIGN_IN_FAILED_TITLE,
  STATE_ERROR_MESSAGE,
} from "./ui.ts";

const COMMON_STYLE_SHA256 = "ebdaece15b70206254f6430990bd14abfbc51a62d319cda6383bc8163b10b4d3";

describe("common MCP auth UI contract", () => {
  test("is branded, escaped, script-free and request-bounded", () => {
    const html = renderConsentPage({
      clientName: "<script>bad</script>",
      tenantName: "Example",
      userEmail: "operator@example.com",
      offeredScopes: ["mcp:read"],
      preChecked: ["mcp:read"],
      csrfToken: "csrf",
      state: "state",
      clientId: "client",
      redirectUri: "https://client.example/callback",
      resource: "",
    });
    expect(html).toContain('data-auth-contract="mcp-auth"');
    expect(html).toContain('name="mcp-auth-ui-contract" content="sha256-ebdaece15b70"');
    expect(html).toContain("max-width:420px");
    expect(html).toContain('value="mcp:read" checked disabled');
    expect(html).toContain('value="switch_account"');
    expect(html).not.toContain("<script>bad</script>");
    expect(html).not.toContain("mcp:admin");
    const response = authHtmlResponse(html);
    expect(response.headers.get("cache-control")).toBe("private,no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  test("provider chooser exposes the canonical SSO-first CTA contract", () => {
    const html = renderProviderChoice([
      { id: "workforce", protocol: "oidc", href: "/workforce" },
      { id: "api-key", protocol: "api_key", href: "/api-key" },
    ]);
    expect(html.indexOf("Continue with SSO")).toBeLessThan(html.indexOf("Continue with API key"));
    expect(html).toContain('class="provider-stack"');
    expect(html).not.toContain("Continue with Continue with");
    const styles = html.match(/\/\*mcp-auth:begin\*\/([\s\S]*?)\/\*mcp-auth:end\*\//)?.[1] ?? "";
    expect(createHash("sha256").update(styles).digest("hex")).toBe(COMMON_STYLE_SHA256);
  });

  test("the funnel declares both schemes, in the family palette", () => {
    // The funnel was `color-scheme:light` and nothing else, so an operator
    // working in dark met a white page. SubKit ships no web console and so has
    // no explicit preference to honour — the media query is the whole answer
    // here, and the .scheme-* classes are carried but never set.
    const html = renderProviderChoice([]);
    expect(html).toContain("color-scheme:light dark");
    expect(html).toContain("@media(prefers-color-scheme:dark)");
    expect(html).toContain("--background:#ffffff;--foreground:#020817");
    expect(html).toContain("--background:#020817;--foreground:#f8fafc");
    expect(html).not.toContain("--ink:");
  });

  test("error page renders inside the shared template with a retry entry point", () => {
    const html = renderErrorPage(
      SIGN_IN_FAILED_TITLE,
      STATE_ERROR_MESSAGE,
      "/v1/identity/login/start",
    );
    expect(html).toContain("<h1>Sign-in failed</h1>");
    expect(html).toContain(
      "This sign-in attempt expired or was already used. Please sign in again.",
    );
    expect(html).toContain('href="/v1/identity/login/start"');
    expect(html).toContain(">Sign in again</a>");
    expect(html).toContain('data-auth-contract="mcp-auth"');
    expect(html).toContain('name="mcp-auth-ui-contract" content="sha256-ebdaece15b70"');
    const styles = html.match(/\/\*mcp-auth:begin\*\/([\s\S]*?)\/\*mcp-auth:end\*\//)?.[1] ?? "";
    expect(createHash("sha256").update(styles).digest("hex")).toBe(COMMON_STYLE_SHA256);
    const response = authHtmlResponse(html, 400);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("error page escapes hostile input and keeps the grant-denied copy verbatim", () => {
    const html = renderErrorPage(
      SIGN_IN_FAILED_TITLE,
      GRANT_DENIED_MESSAGE,
      "/v1/identity/login/start",
    );
    expect(html).toContain("Your account is not authorized for SubKit. Contact the operator.");
    const hostile = renderErrorPage(
      "<script>x</script>",
      "<img src=x>",
      "/v1/identity/login/start",
    );
    expect(hostile).not.toContain("<script>x</script>");
    expect(hostile).not.toContain("<img src=x>");
  });
});
