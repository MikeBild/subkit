// Unit tests for the vendor-recipe gate scanner.

import { describe, expect, it } from "bun:test";

import { vendorRecipeScanner } from "../scanners/vendor-recipe.ts";

const ctx = { engine_url: "https://subkit-api.example.com" };

function block(json: unknown): string {
  return ["Here is the config:", "```json", JSON.stringify(json, null, 2), "```", "Done."].join(
    "\n",
  );
}

describe("vendorRecipeScanner", () => {
  it("passes a clean MCP config that uses the real engine_url and a real bearer", () => {
    const text = block({
      mcpServers: {
        subkit: {
          url: "https://subkit-api.example.com/mcp",
          transport: "streamable-http",
          headers: { Authorization: "Bearer wf_live_abcdef0123456789abcdef0123456789" },
        },
      },
    });
    expect(vendorRecipeScanner.scan(text, ctx)).toEqual([]);
  });

  it("flags an MCP config whose URL host differs from engine_url", () => {
    const text = block({
      mcpServers: {
        subkit: {
          url: "https://subkit-api.other.dev/mcp",
          transport: "streamable-http",
          headers: { Authorization: "Bearer wf_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
        },
      },
    });
    const vs = vendorRecipeScanner.scan(text, ctx);
    expect(vs.map((v) => v.kind)).toContain("vendor_recipe.host_mismatch");
  });

  it("flags an MCP config whose URL path is not /mcp", () => {
    const text = block({
      mcpServers: {
        subkit: {
          url: "https://subkit-api.example.com/v1/mcp-but-wrong",
          transport: "streamable-http",
          headers: { Authorization: "Bearer wf_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
        },
      },
    });
    const vs = vendorRecipeScanner.scan(text, ctx);
    expect(vs.map((v) => v.kind)).toContain("vendor_recipe.bad_path");
  });

  it("flags placeholder authorization headers", () => {
    const text = block({
      mcpServers: {
        subkit: {
          url: "https://subkit-api.example.com/mcp",
          transport: "streamable-http",
          headers: { Authorization: "Bearer <YOUR_API_KEY>" },
        },
      },
    });
    const vs = vendorRecipeScanner.scan(text, ctx);
    expect(vs.map((v) => v.kind)).toContain("vendor_recipe.placeholder_auth");
  });

  it("ignores foreign mcp configs (other vendor's MCP server)", () => {
    const text = block({
      mcpServers: {
        github: {
          url: "https://api.github.com/mcp",
          transport: "streamable-http",
          headers: { Authorization: "Bearer ghp_xxxxxx" },
        },
      },
    });
    expect(vendorRecipeScanner.scan(text, ctx)).toEqual([]);
  });

  it("ignores stdio entries (no url to validate)", () => {
    const text = block({
      mcpServers: {
        subkit: { command: "sk", args: ["mcp"] },
      },
    });
    expect(vendorRecipeScanner.scan(text, ctx)).toEqual([]);
  });

  it("ignores fenced blocks that are not JSON", () => {
    const text = "```bash\nsk mcp\n```";
    expect(vendorRecipeScanner.scan(text, ctx)).toEqual([]);
  });

  it("ignores text without any fenced JSON block", () => {
    expect(vendorRecipeScanner.scan("plain prose, no config", ctx)).toEqual([]);
  });
});
