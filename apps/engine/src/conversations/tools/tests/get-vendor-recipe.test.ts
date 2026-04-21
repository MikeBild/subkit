// Unit tests for the get_vendor_recipe conversation tool.
//
// The tool is intentionally read-only and free of side effects, so no
// DB, no engine client — we invoke `execute` with a stub context and
// assert the shape of the returned data. This is the same shape the
// LLM sees on the tool_result message.

import { describe, expect, test } from "bun:test";
import { listVendorRecipes } from "../../../llm/manifests/vendor-recipes.ts";
import { getVendorRecipeTool } from "../get-vendor-recipe.ts";
import type { ToolContext } from "../index.ts";

const STUB_CTX = {} as ToolContext;

describe("get_vendor_recipe — tool metadata contract", () => {
  test("is read-only (tenant_read) so it cannot trigger a confirmation dialog", () => {
    expect(getVendorRecipeTool.category).toBe("tenant_read");
  });

  test("description instructs the model to call this BEFORE emitting a config block", () => {
    expect(getVendorRecipeTool.description).toMatch(/before emitting any config block/i);
    expect(getVendorRecipeTool.description).toMatch(/do not invent/i);
  });

  test("description routes not_found to cannot_help rather than a fallback guess", () => {
    expect(getVendorRecipeTool.description).toMatch(/cannot_help/);
    expect(getVendorRecipeTool.description).toMatch(/vendor_recipe\.<client>/);
  });
});

describe("get_vendor_recipe — execute", () => {
  test("returns the codex recipe with freshness metadata", async () => {
    const result = await getVendorRecipeTool.execute(STUB_CTX, { client: "codex" });
    expect(result.ok).toBe(true);
    const data = result.data as {
      recipe: { client: string; transports: string[]; config_template_streamable_http: unknown };
      freshness: { status: "fresh" | "warn" | "stale"; age_days: number };
    };
    expect(data.recipe.client).toBe("codex");
    expect(data.recipe.transports).toContain("streamable-http");
    expect(data.recipe.config_template_streamable_http).toBeDefined();
    expect(["fresh", "warn", "stale"]).toContain(data.freshness.status);
    expect(typeof data.freshness.age_days).toBe("number");
  });

  test("returns the claude-desktop recipe too (at least two clients in the manifest)", async () => {
    const result = await getVendorRecipeTool.execute(STUB_CTX, { client: "claude-desktop" });
    expect(result.ok).toBe(true);
    const data = result.data as { recipe: { client: string } };
    expect(data.recipe.client).toBe("claude-desktop");
  });

  test("folds whitespace / underscores to hyphens for client matching", async () => {
    const withSpace = await getVendorRecipeTool.execute(STUB_CTX, { client: "Claude Desktop" });
    const withUnderscore = await getVendorRecipeTool.execute(STUB_CTX, {
      client: "claude_desktop",
    });
    expect(withSpace.ok).toBe(true);
    expect(withUnderscore.ok).toBe(true);
  });

  test("returns a typed not_found for unknown clients, with the list of available ones", async () => {
    const result = await getVendorRecipeTool.execute(STUB_CTX, { client: "unknown-ide" });
    expect(result.ok).toBe(false);
    const data = result.data as {
      error: string;
      requested: string;
      available_clients: string[];
      reason: string;
    };
    expect(data.error).toBe("not_found");
    expect(data.requested).toBe("unknown-ide");
    expect(Array.isArray(data.available_clients)).toBe(true);
    expect(data.available_clients.length).toBeGreaterThan(0);
    expect(data.reason).toMatch(/cannot_help/);
  });

  test("available_clients in the not_found payload matches the manifest", async () => {
    const result = await getVendorRecipeTool.execute(STUB_CTX, { client: "no-such-thing" });
    const data = result.data as { available_clients: string[] };
    const manifestClients = listVendorRecipes().map((r) => r.client);
    expect(data.available_clients).toEqual(manifestClients);
  });

  test("rejects empty client strings via zod (input validation)", async () => {
    await expect(getVendorRecipeTool.execute(STUB_CTX, { client: "" })).rejects.toThrow();
  });
});
