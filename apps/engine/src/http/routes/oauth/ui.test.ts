import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { authHtmlResponse, renderConsentPage, renderProviderChoice } from "./ui.ts";

const COMMON_STYLE_SHA256 = "61333cf68d1c955484e7c8fd1e5b68ad9ff4caf9e99799493f868bd19dcb9e64";

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
});
