import { describe, expect, it } from "bun:test";
import type { EnhancedPrompt } from "../../types.ts";
import { splitPromptIntoBlocks, toSystemMessages } from "../cache-blocks.ts";

function makePrompt(system: string): EnhancedPrompt {
  return {
    system,
    messages: [],
    token_counts: {
      system: 0,
      skills: 0,
      knowledge: 0,
      docs: 0,
      failures: 0,
      messages: 0,
      total: 0,
    },
    included_skill_ids: [],
    included_chunk_ids: [],
    included_knowledge_chunk_ids: [],
    included_skills: [],
    included_chunks: [],
    included_knowledge_chunks: [],
  };
}

describe("splitPromptIntoBlocks", () => {
  it("classifies skills/docs/knowledge as stable and failures/memory as volatile", () => {
    const sys = [
      "You are the subkit workflow engine.",
      "# Skill: Writing endpoints (global)\nbody of skill",
      "## Doc: example.com — /users\nsome doc content",
      "## Knowledge: Glossary\nterms",
      "# User memory\nplease use snake_case",
      "## Prior failure: step-1\nerror happened",
    ].join("\n\n");
    const blocks = splitPromptIntoBlocks(makePrompt(sys), "converse");
    expect(blocks.stable).toContain("You are the subkit workflow engine.");
    expect(blocks.stable).toContain("# Skill: Writing endpoints");
    expect(blocks.stable).toContain("## Doc: example.com");
    expect(blocks.stable).toContain("## Knowledge: Glossary");
    expect(blocks.stable).not.toContain("Prior failure");
    expect(blocks.stable).not.toContain("User memory");

    expect(blocks.volatile).toContain("# User memory");
    expect(blocks.volatile).toContain("## Prior failure: step-1");
  });

  it("reports token counts for both blocks", () => {
    const blocks = splitPromptIntoBlocks(makePrompt("hello\n\n# Skill: X\nbody"), "generate");
    expect(blocks.token_counts.stable).toBeGreaterThan(0);
  });

  it("handles empty prompt gracefully", () => {
    const blocks = splitPromptIntoBlocks(makePrompt(""), "generate");
    expect(blocks.stable).toBe("");
    expect(blocks.volatile).toBe("");
  });
});

describe("toSystemMessages", () => {
  it("attaches cacheControl to stable when enabled", () => {
    const msgs = toSystemMessages(
      {
        stable: "stable head",
        volatile: "volatile tail",
        token_counts: { stable: 1, volatile: 1 },
      },
      { enabled: true, ttl: "1h" },
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content).toBe("stable head");
    expect(msgs[0]!.providerOptions?.anthropic.cacheControl).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(msgs[1]!.content).toBe("volatile tail");
    expect(msgs[1]!.providerOptions).toBeUndefined();
  });

  it("omits cacheControl when disabled", () => {
    const msgs = toSystemMessages(
      {
        stable: "head",
        volatile: "tail",
        token_counts: { stable: 1, volatile: 1 },
      },
      { enabled: false },
    );
    expect(msgs[0]!.providerOptions).toBeUndefined();
  });

  it("skips empty blocks", () => {
    const msgs = toSystemMessages(
      { stable: "", volatile: "tail", token_counts: { stable: 0, volatile: 1 } },
      { enabled: true },
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe("tail");
  });
});
