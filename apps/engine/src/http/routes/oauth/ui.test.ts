import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  authHtmlResponse,
  GRANT_DENIED_MESSAGE,
  renderConsentPage,
  renderErrorPage,
  renderProviderChoice,
  resolveAuthLocale,
  SIGN_IN_FAILED_TITLE,
  STATE_ERROR_MESSAGE,
} from "./ui.ts";

const COMMON_STYLE_SHA256 = "be7803cb8701e77144e7e91642f5a6e2d2fd8284d9c6c82b0f4e5efa9c4fea5a";

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
    expect(html).toContain('name="mcp-auth-ui-contract" content="sha256-be7803cb8701"');
    expect(html).toContain("max-width:420px");
    expect(html).toContain('value="mcp:read" checked disabled');
    expect(html).toContain('value="switch_account"');
    expect(html).not.toContain("<script>bad</script>");
    expect(html).not.toContain("mcp:admin");
    const response = authHtmlResponse(html);
    expect(response.headers.get("cache-control")).toBe("private,no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  test("the consent page speaks the browser's language and shows where the client lives", () => {
    const html = renderConsentPage({
      clientName: "Probe Service",
      clientUri: "https://probe.example",
      tenantName: "Example",
      userEmail: "operator@example.com",
      offeredScopes: ["mcp:read", "mcp:authoring"],
      preChecked: ["mcp:read"],
      csrfToken: "csrf",
      state: "state",
      clientId: "client",
      redirectUri: "https://probe.example/callback",
      resource: "",
      locale: "de",
    });
    expect(html).toContain('<html lang="de">');
    expect(html).toContain("Zugriff freigeben");
    expect(html).toContain('möchte auf <span class="strong">Example</span> zugreifen');
    expect(html).toContain('data-testid="auth-client-uri"');
    expect(html).toContain("https://probe.example");
    expect(html).toContain('value="approve" class="approve">Freigeben<');
    expect(html).toContain('value="deny" class="deny">Ablehnen<');
    expect(html).toContain("Bearbeiten · mcp:authoring");
    expect(html).not.toContain("Approve");
    const bare = renderConsentPage({
      clientName: "Probe Service",
      tenantName: "Example",
      userEmail: "operator@example.com",
      offeredScopes: ["mcp:read"],
      preChecked: ["mcp:read"],
      csrfToken: "csrf",
      state: "state",
      clientId: "client",
      redirectUri: "https://probe.example/callback",
      resource: "",
    });
    expect(bare).not.toContain("auth-client-uri");
    expect(bare).toContain("Authorize access");
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

  test("provider chooser follows the family identity and browser locale contract", () => {
    expect(resolveAuthLocale("de-DE,de;q=0.9,en;q=0.8")).toBe("de");
    expect(resolveAuthLocale("fr-FR,fr;q=0.9")).toBe("en");
    const html = renderProviderChoice(
      [
        { id: "api-key", protocol: "api_key", href: "/api-key" },
        { id: "workforce", protocol: "oidc", href: "/workforce" },
      ],
      "de",
    );
    expect(html).toContain('<html lang="de">');
    expect(html).toContain('data-auth-product="subkit"');
    expect(html).toContain('data-testid="auth-product-icon"');
    expect(html).toContain("Bei SubKit anmelden");
    expect(html).toContain("SubKit · OAuth 2.1");
    expect(html.indexOf('data-auth-provider="sso"')).toBeLessThan(
      html.indexOf('data-auth-provider="api-key"'),
    );
  });

  test("the funnel declares both schemes, in the family palette", () => {
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
    expect(html).toContain('name="mcp-auth-ui-contract" content="sha256-be7803cb8701"');
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
