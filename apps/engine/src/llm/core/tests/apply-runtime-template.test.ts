// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${…}` tokens are the subject under test — these are intentional placeholders, not accidental template-literal typos.

// Tests for applyRuntimeTemplate — the pre-LLM template step that
// substitutes whitelisted runtime-context tokens (engine_url,
// tenant_slug, actor_email, actor_role, surface) into a skill body
// BEFORE it reaches the model. This mirrors Claude Code's pattern of
// rendering concrete environment values into the system prompt at
// build time instead of leaving the model to splice them at runtime.
//
// The point is to prevent the "model sees `${engine_url}` and either
// leaves it as a literal or invents `your-subkit-instance.com`" class
// of bug. Only whitelisted keys are substituted; unknown `${…}` tokens
// (e.g. `${plaintext_key}`, `${cred.slack.token}`, `${input.path}`)
// pass through untouched so the skill author can still describe
// placeholders the user or the executor will fill in later.

import { describe, expect, it } from "bun:test";
import { applyRuntimeTemplate } from "../context-assembler.ts";

describe("applyRuntimeTemplate", () => {
  it("substitutes ${engine_url} with the runtime value", () => {
    const out = applyRuntimeTemplate("Hit ${engine_url}/mcp with a Bearer header.", {
      engine_url: "http://subkit-api.example.com",
    });
    expect(out).toBe("Hit http://subkit-api.example.com/mcp with a Bearer header.");
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
    // Only `tenant_slug` is supplied — engine_url stays as a literal so
    // a downstream output guard can flag it rather than being silently
    // dropped.
    const out = applyRuntimeTemplate("engine=${engine_url}, tenant=${tenant_slug}", {
      tenant_slug: "acme",
    });
    expect(out).toBe("engine=${engine_url}, tenant=acme");
  });
});
