import { describe, expect, test } from "bun:test";
import { authHtmlResponse, renderConsentPage, renderProviderChoice } from "./ui.ts";

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
    expect(html).toContain('data-auth-contract="mcp-auth-v1"');
    expect(html).toContain('name="mcp-auth-ui-contract" content="1"');
    expect(html).toContain("max-width:420px");
    expect(html).toContain('value="mcp:read" checked disabled');
    expect(html).toContain('value="switch_account"');
    expect(html).not.toContain("<script>bad</script>");
    expect(html).not.toContain("mcp:admin");
    const response = authHtmlResponse(html);
    expect(response.headers.get("cache-control")).toBe("private,no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  test("provider chooser supports independent login methods", () => {
    const html = renderProviderChoice([
      { id: "api_key", label: "SubKit API key", href: "/api-key" },
      { id: "workforce", label: "Workforce", href: "/workforce" },
      { id: "partner", label: "Partner", href: "/partner" },
    ]);
    expect(html).toContain("SubKit API key");
    expect(html).toContain("Workforce");
    expect(html).toContain("Partner");
  });
});
