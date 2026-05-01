// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${…}` tokens are the subject under test — the skill body uses them as runtime-template markers.

// Contract test for the mcp-server-setup skill body.
//
// After the refactor from vendor-specific "mcp-codex-integration" →
// generic "mcp-server-setup", the skill body must be a pointer to
// the `get_vendor_recipe` tool and the VendorRecipeManifest — NOT a
// re-statement of each client's JSON config shape. Adding a vendor
// template back into this file would undo the data-driven design and
// force every new MCP client (Cursor, Continue, Zed, Goose, …) to
// touch this prompt. The contract test makes that regression loud.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SKILL_PATH = fileURLToPath(new URL("../mcp-server-setup.md", import.meta.url));
const body = readFileSync(SKILL_PATH, "utf8");

describe("mcp-server-setup skill", () => {
  it("exists at the new slug (the old vendor-specific slug is gone)", () => {
    expect(body).toContain("slug: mcp-server-setup");
    expect(body).not.toContain("slug: mcp-codex-integration");
  });

  it("instructs the model to call get_vendor_recipe before emitting a config block", () => {
    expect(body).toContain("get_vendor_recipe");
    expect(body).toMatch(/do not invent/i);
  });

  it("routes missing recipes to cannot_help with a typed missing_capability", () => {
    expect(body).toContain("cannot_help");
    expect(body).toContain("vendor_recipe.<client>");
  });

  it("does NOT re-state the Codex or Claude-Desktop config JSON inline", () => {
    // The manifest is the source of truth. If anyone adds the full
    // mcpServers JSON block back into this skill, the contract breaks.
    expect(body).not.toContain('"transport": "streamable-http"');
    expect(body).not.toContain('"Authorization": "Bearer ${plaintext_key}"');
    expect(body).not.toMatch(/"mcpServers":\s*\{\s*"subkit":/);
  });

  it("delegates flow discipline to the base-prompt TURN-ONE rule, not a local six-step recipe", () => {
    expect(body).toContain("TURN-ONE DISCIPLINE");
    expect(body).not.toContain("Six-step flow");
  });

  it("auto-loads on broad MCP keywords, not a single vendor name", () => {
    // Schema: `activates_when` JSON array carries `{kind: "baseline"}`
    // (auto-load equivalent) plus `{kind: "intent_keyword", word: ...}`
    // entries. Pre-refactor this was `auto_load: true` +
    // `trigger_keywords: [...]`; the contract is unchanged.
    expect(body).toMatch(/activates_when:.*"kind":"baseline"/);
    expect(body).toContain('"word":"mcp server"');
    expect(body).toContain('"word":"cursor"');
    expect(body).toContain('"word":"continue"');
    expect(body).toContain('"word":"zed"');
    expect(body).toContain('"word":"goose"');
  });

  it("preserves the runtime-substitution contract for engine_url", () => {
    // The assembler pre-substitutes ${engine_url} at build time; the
    // skill body must use that exact token so the substitution hits.
    expect(body).toContain("${engine_url}/mcp");
  });
});
