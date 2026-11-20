import { expect, test } from "bun:test";
import { authorityBoundariesDe, authorityBoundariesEn } from "./i18n/authority-boundaries";

test("every string is one sentence, in both languages, without an exclamation mark", () => {
  for (const catalog of [authorityBoundariesEn, authorityBoundariesDe])
    for (const [key, text] of Object.entries(catalog)) {
      const sentenceEnds = text.match(/[.?](?=\s|$)/g) ?? [];
      expect(sentenceEnds.length, key).toBeLessThanOrEqual(1);
      expect(text, key).not.toContain("!");
      expect(text, key).not.toContain("—");
    }
});

test("no hint claims to be the tool's own statement", () => {
  for (const catalog of [authorityBoundariesEn, authorityBoundariesDe])
    for (const key of [
      "authority.mcp.hintReadOnly",
      "authority.mcp.hintDestructive",
      "authority.mcp.hintChanges",
      "authority.mcp.hintNone",
    ] as const) {
      expect(catalog[key]).not.toMatch(/describes itself|beschreibt sich selbst|own description/);
      expect(catalog[key]).toMatch(/server|Server/);
    }
});

test("every new refusal has a sentence in both languages", () => {
  for (const key of [
    "authority.refusal.connector_query_needs_boundary",
    "authority.refusal.mcp_write_needs_single_attempt",
    "authority.refusal.mcp_tool_changed",
    "authority.refusal.mcp_tool_unavailable",
  ] as const) {
    expect(authorityBoundariesEn[key].length).toBeGreaterThan(40);
    expect(authorityBoundariesDe[key].length).toBeGreaterThan(40);
  }
});
