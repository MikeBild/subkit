import { splitPromptIntoBlocks } from "../../src/llm/core/cache-blocks.ts";
import { formatOperatorQuirks } from "../../src/llm/core/context-assembler.ts";
import type { EnhancedPrompt } from "../../src/llm/types.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

const QUIRKS = {
  auth: "auth body",
  schema: "schema body",
  general: "general body",
};

function makePrompt(stableHead: string, quirkSlot: "auth" | "schema" | "general"): EnhancedPrompt {
  const block = formatOperatorQuirks("c", "C", QUIRKS, [quirkSlot])!;
  return {
    system: `${stableHead}\n\n${block}`,
    system_sections: [
      { text: stableHead, volatile: false },
      { text: block, volatile: true },
    ],
    messages: [],
    token_counts: {
      system: 0,
      skills: 0,
      knowledge: 0,
      docs: 0,
      failures: 0,
      messages: 0,
      total: 0,
      recipe_bodies: 0,
      skill_candidates: 0,
    },
    included_skill_ids: [],
    included_chunk_ids: [],
    included_knowledge_chunk_ids: [],
    included_skills: [],
    included_chunks: [],
    included_knowledge_chunks: [],
  };
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const stableHead = (fixture.input as { stable_head: string }).stable_head;
  const fails: string[] = [];

  const blocks = ["auth", "schema", "general"].map((slot) =>
    splitPromptIntoBlocks(
      makePrompt(stableHead, slot as "auth" | "schema" | "general"),
      "converse",
    ),
  );

  const prefixes = blocks.map((b) => b.stable);
  const [a, c1, c2] = prefixes;
  if (a !== c1 || a !== c2) {
    fails.push("stable prefix differs across quirk-category swaps — cache key would invalidate");
  }
  if (!a?.includes("# Skill:")) fails.push("skill header missing from stable prefix");
  if (!a?.includes("# Available recipes")) fails.push("recipe header missing from stable prefix");
  for (const block of blocks) {
    if (block.stable.includes("# Operator quirks")) {
      fails.push("operator quirks leaked into stable prefix");
      break;
    }
    if (!block.volatile.includes("# Operator quirks")) {
      fails.push("operator quirks missing from volatile tail");
      break;
    }
  }

  if (fails.length > 0) return { pass: false, reason: fails.join("; ") };
  return { pass: true };
}
