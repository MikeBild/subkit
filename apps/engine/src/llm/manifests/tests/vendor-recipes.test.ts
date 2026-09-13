// Unit tests for VendorRecipeManifest — loader + freshness contract.

import { describe, expect, it } from "bun:test";

import { getVendorRecipe, listVendorRecipes, recipeFreshness } from "../vendor-recipes.ts";

describe("VendorRecipeManifest", () => {
  it("ships the codex recipe", () => {
    const r = getVendorRecipe("codex");
    expect(r?.client).toBe("codex");
    expect(r?.transports).toContain("streamable-http");
    expect(r?.config_template_streamable_http).toBeDefined();
  });

  it("ships the claude-desktop recipe", () => {
    const r = getVendorRecipe("claude-desktop");
    expect(r?.client).toBe("claude-desktop");
  });

  it("normalises lookup (case + space + underscore tolerant)", () => {
    expect(getVendorRecipe("Claude Desktop")?.client).toBe("claude-desktop");
    expect(getVendorRecipe("CLAUDE_DESKTOP")?.client).toBe("claude-desktop");
  });

  it("returns undefined for unknown client (and the assistant must call cannot_help)", () => {
    expect(getVendorRecipe("cursor")).toBeUndefined();
  });

  it("listVendorRecipes returns at least the two seeded entries", () => {
    expect(listVendorRecipes().length).toBeGreaterThanOrEqual(2);
  });

  it("freshness is fresh within 60 days, warn at 60-89, stale at 90+", () => {
    const r = getVendorRecipe("codex")!;
    const verifiedAt = new Date(r.verified_at);
    const f10 = recipeFreshness(r, new Date(verifiedAt.getTime() + 10 * 86_400_000));
    expect(f10.status).toBe("fresh");
    const f60 = recipeFreshness(r, new Date(verifiedAt.getTime() + 60 * 86_400_000));
    expect(f60.status).toBe("warn");
    const f90 = recipeFreshness(r, new Date(verifiedAt.getTime() + 90 * 86_400_000));
    expect(f90.status).toBe("stale");
  });

  it("contract: every shipped recipe is currently fresh (verified within last 90 days as of today)", () => {
    for (const r of listVendorRecipes()) {
      const f = recipeFreshness(r);
      // Allow `warn` here — failure is reserved for fully stale entries that
      // need re-verification before the next release.
      expect(f.status).not.toBe("stale");
    }
  });
});
