import { describe, expect, test } from "bun:test";
import { extractAnchors, slugify } from "../check-docs-refs.ts";

describe("slugify", () => {
  test("lowercases and hyphenates words", () => {
    expect(slugify("Deployment Topology")).toBe("deployment-topology");
  });

  test("drops punctuation but keeps each space as a hyphen (no collapsing)", () => {
    // Regression: "A & B" must become "a--b" — GitHub maps the two surviving
    // spaces (around the removed `&`) to two hyphens, it does not collapse them.
    expect(slugify("Scripting & CI (non-interactive)")).toBe("scripting--ci-non-interactive");
  });

  test("strips backtick/asterisk/tilde emphasis markers", () => {
    expect(slugify("`code` and **bold**")).toBe("code-and-bold");
  });

  test("drops dots but preserves intra-word hyphens and underscores", () => {
    // Config-key headings like `sandbox.memory_bytes` are common in this repo;
    // GitHub drops the dot and keeps the underscore.
    expect(slugify("sandbox.memory_bytes")).toBe("sandboxmemory_bytes");
    expect(slugify("self-healing and tenant_id")).toBe("self-healing-and-tenant_id");
  });
});

describe("extractAnchors", () => {
  test("collects slugs for ATX headings at any level", () => {
    const md = ["# Title", "intro", "## Deployment Topology", "### Sub-Section"].join("\n");
    const anchors = extractAnchors(md);
    expect(anchors.has("title")).toBe(true);
    expect(anchors.has("deployment-topology")).toBe(true);
    expect(anchors.has("sub-section")).toBe(true);
  });

  test("ignores non-heading lines", () => {
    const anchors = extractAnchors("not a heading\n#alsonotone");
    expect(anchors.size).toBe(0);
  });
});
