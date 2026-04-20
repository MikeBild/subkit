// Unit tests for the runtime-context module — the per-turn ground
// truth block injected into the system prompt.

import { describe, expect, it } from "bun:test";
import { renderRuntimeContextBlock, resolveEngineUrl } from "../runtime-context.ts";

describe("renderRuntimeContextBlock", () => {
  it("returns null when no fields are set (no empty header burns cache space)", () => {
    expect(renderRuntimeContextBlock({})).toBeNull();
  });

  it("renders engine_url verbatim and forbids placeholder hosts", () => {
    const block = renderRuntimeContextBlock({ engine_url: "https://subkit-api.mikebild.dev" });
    expect(block).toContain("- engine_url: https://subkit-api.mikebild.dev");
    expect(block).toContain("never paraphrase");
    expect(block).toContain("your-subkit-instance.com");
    expect(block).toContain("cannot_help");
  });

  it("includes tenant_slug, actor_email, actor_role and surface when present", () => {
    const block = renderRuntimeContextBlock({
      engine_url: "https://e",
      tenant_slug: "acme",
      actor_email: "mike@example.com",
      actor_role: "operator",
      surface: "web",
    });
    expect(block).toContain("- tenant_slug: acme");
    expect(block).toContain("- actor_email: mike@example.com");
    expect(block).toContain("- actor_role: operator");
    expect(block).toContain("- surface: web");
  });

  it("omits absent optional fields (no `undefined` lines)", () => {
    const block = renderRuntimeContextBlock({ engine_url: "https://e", tenant_slug: "acme" });
    expect(block).not.toContain("undefined");
    expect(block).not.toContain("- actor_email:");
    expect(block).not.toContain("- actor_role:");
  });

  it("drops the cannot_help fallback only when engine_url is present", () => {
    // The rule text always mentions cannot_help — ensures the model has a
    // structured escape hatch even when the host slot is filled. The
    // *other* manifests (tenant, vendor recipe) drive their own
    // cannot_help calls; this block's contract is just the engine_url
    // honesty rule.
    const block = renderRuntimeContextBlock({ engine_url: "https://e" });
    expect(block).toContain("cannot_help");
  });
});

describe("resolveEngineUrl", () => {
  it("returns the request's origin when present", () => {
    const url = resolveEngineUrl({ url: "https://subkit-api.mikebild.dev/v1/conversations" });
    expect(url).toBe("https://subkit-api.mikebild.dev");
  });

  it("strips path, query and hash", () => {
    const url = resolveEngineUrl({
      url: "https://host:8443/foo/bar?x=1#frag",
    });
    expect(url).toBe("https://host:8443");
  });

  it("falls back to SUBKIT_PUBLIC_BASE_URL on a malformed url", () => {
    const prev = process.env.SUBKIT_PUBLIC_BASE_URL;
    process.env.SUBKIT_PUBLIC_BASE_URL = "https://from-env.example";
    try {
      const url = resolveEngineUrl({ url: "not a url" });
      expect(url).toBe("https://from-env.example");
    } finally {
      if (prev === undefined) delete process.env.SUBKIT_PUBLIC_BASE_URL;
      else process.env.SUBKIT_PUBLIC_BASE_URL = prev;
    }
  });

  it("returns undefined when both the request and the env are unusable", () => {
    const prev = process.env.SUBKIT_PUBLIC_BASE_URL;
    delete process.env.SUBKIT_PUBLIC_BASE_URL;
    try {
      const url = resolveEngineUrl({ url: "" });
      expect(url).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.SUBKIT_PUBLIC_BASE_URL = prev;
    }
  });
});
