// Unit tests for the discover-flow draft validator.

import { describe, expect, it } from "bun:test";
import { type DiscoverArtifact, validateDiscoverDraft } from "../flows/discover.ts";

function mk(kind: DiscoverArtifact["kind"], draft: Record<string, unknown>): DiscoverArtifact {
  return {
    kind,
    title: "x",
    description: "y",
    draft,
    evidence_excerpts: [],
    confidence: 50,
  };
}

describe("validateDiscoverDraft", () => {
  it("accepts a complete connector draft", () => {
    expect(
      validateDiscoverDraft(
        mk("connector", { name: "Stripe", base_url: "https://api.stripe.com" }),
      ),
    ).toBeNull();
  });

  it("accepts a connector draft with template_slug instead of base_url", () => {
    expect(
      validateDiscoverDraft(mk("connector", { name: "X", template_slug: "tpl-123" })),
    ).toBeNull();
  });

  it("rejects a connector draft with legacy template_id instead of template_slug", () => {
    const issues = validateDiscoverDraft(mk("connector", { name: "X", template_id: "tpl-123" }));
    expect(issues).toContain(
      "connector draft requires one of `base_url`, `template_slug`, `driver`",
    );
  });

  it("rejects a connector draft missing name", () => {
    const issues = validateDiscoverDraft(mk("connector", { base_url: "https://x" }));
    expect(issues).toContain("connector draft requires `name`");
  });

  it("rejects a connector draft missing base_url, template binding, and driver", () => {
    const issues = validateDiscoverDraft(mk("connector", { name: "X" }));
    expect(issues?.some((i) => i.includes("base_url"))).toBe(true);
  });

  it("accepts a complete skill draft", () => {
    expect(validateDiscoverDraft(mk("skill", { title: "S", body: "..." }))).toBeNull();
  });

  it("rejects a skill draft missing title", () => {
    const issues = validateDiscoverDraft(mk("skill", { body: "x" }));
    expect(issues).toContain("skill draft requires `title`");
  });

  it("accepts a knowledge_source draft with name + source_uri", () => {
    expect(
      validateDiscoverDraft(mk("knowledge_source", { name: "K", source_uri: "kb.md" })),
    ).toBeNull();
  });

  it("rejects a knowledge_source draft with no content carrier", () => {
    const issues = validateDiscoverDraft(mk("knowledge_source", { name: "X" }));
    expect(issues?.some((i) => i.includes("content"))).toBe(true);
  });
});
