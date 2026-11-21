import { describe, expect, it } from "bun:test";
import { SK_INSTALL_GROUNDING } from "../../../conversations/agent/prompts.ts";
import { applyRuntimeTemplate } from "../context-assembler.ts";

describe("applyRuntimeTemplate", () => {
  it("substitutes ${engine_url} with the runtime value", () => {
    const out = applyRuntimeTemplate("Hit ${engine_url}/mcp with a Bearer header.", {
      engine_url: "http://subkit-api.example.com",
    });
    expect(out).toBe("Hit http://subkit-api.example.com/mcp with a Bearer header.");
  });

  it("renders the install-grounding command with the real host (the P1 outcome)", () => {
    const out = applyRuntimeTemplate(SK_INSTALL_GROUNDING, {
      engine_url: "https://engine.example.com",
    });
    expect(out).toContain("curl -fsSL https://engine.example.com/install | bash");
    expect(out).not.toContain("${engine_url}");
  });

  it("leaves the install token literal when no engine_url is known", () => {
    const out = applyRuntimeTemplate(SK_INSTALL_GROUNDING, {});
    expect(out).toContain("${engine_url}/install");
  });

  it("substitutes multiple whitelisted tokens in a single pass", () => {
    const out = applyRuntimeTemplate("${actor_email} on ${tenant_slug} via ${surface}", {
      engine_url: "http://x",
      tenant_slug: "acme",
      actor_email: "m@x.dev",
      surface: "sk_interactive",
    });
    expect(out).toBe("m@x.dev on acme via sk_interactive");
  });

  it("leaves non-whitelisted tokens untouched — skill authors still control placeholders", () => {
    const body = '"Authorization": "Bearer ${plaintext_key}"';
    const out = applyRuntimeTemplate(body, { engine_url: "http://x" });
    expect(out).toBe(body);
  });

  it("mixed body: substitutes runtime tokens, preserves user-facing placeholders", () => {
    const body =
      '{"url":"${engine_url}/mcp","headers":{"Authorization":"Bearer ${plaintext_key}"}}';
    const out = applyRuntimeTemplate(body, { engine_url: "http://host.dev" });
    expect(out).toBe(
      '{"url":"http://host.dev/mcp","headers":{"Authorization":"Bearer ${plaintext_key}"}}',
    );
  });

  it("passes through unchanged when the body has no ${ token", () => {
    const out = applyRuntimeTemplate("plain body with no tokens", {
      engine_url: "http://x",
    });
    expect(out).toBe("plain body with no tokens");
  });

  it("passes through unchanged when no runtime context is provided", () => {
    const out = applyRuntimeTemplate("Hit ${engine_url}/mcp");
    expect(out).toBe("Hit ${engine_url}/mcp");
  });

  it("leaves ${engine_url} unresolved when the value is missing from context", () => {
    const out = applyRuntimeTemplate("engine=${engine_url}, tenant=${tenant_slug}", {
      tenant_slug: "acme",
    });
    expect(out).toBe("engine=${engine_url}, tenant=acme");
  });
});
