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

const COMMON_STYLE_SHA256 = "fb9d19063e79757a73139720508cf27207214b98405e156bab894bad85796a0c";

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
    expect(html).toContain('data-auth-contract="mcp-auth-v2"');
    expect(html).toContain('name="mcp-auth-ui-contract" content="2"');
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
    const styles = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(createHash("sha256").update(styles).digest("hex")).toBe(COMMON_STYLE_SHA256);
  });

  test("tokens pin the neutral ink primary with black hover", () => {
    const html = renderProviderChoice([]);
    expect(html).toContain("--primary:#1f2328;--primary-hover:#000");
    expect(html).not.toContain("#1f6feb");
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
    expect(html).toContain('data-auth-contract="mcp-auth-v2"');
    expect(html).toContain('name="mcp-auth-ui-contract" content="2"');
    const styles = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
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
