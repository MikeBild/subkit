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

  // Render the same skill+recipe stable head with three different
  // per-turn quirk slots. The stable cache prefix (skills + docs +
  // knowledge + recipes) must be byte-identical across turns. The
  // quirks block lives at the tail of the stable head, but the
  // splitter classifies skills/docs/knowledge first — the recipe
  // header (`# Available recipes`) is part of the stable head as far
  // as the cache splitter is concerned because it does not match the
  // memory/failure markers that drop it into volatile.
  const blocks = ["auth", "schema", "general"].map((slot) =>
    splitPromptIntoBlocks(
      makePrompt(stableHead, slot as "auth" | "schema" | "general"),
      "converse",
    ),
  );

  // Compute the substring of each `stable` portion that is upstream of
  // the quirks block (i.e. the skill + recipe headers). That prefix
  // must be byte-identical across all three.
  const prefixes = blocks.map((b) => b.stable.split("# Operator quirks")[0] ?? "");
  const [a, c1, c2] = prefixes;
  if (a !== c1 || a !== c2) {
    fails.push("stable prefix differs across quirk-category swaps — cache key would invalidate");
  }
  // The skill/recipe headers must actually be present in the stable
  // section (otherwise the test is trivially passing on empty strings).
  if (!a?.includes("# Skill:")) fails.push("skill header missing from stable prefix");
  if (!a?.includes("# Available recipes")) fails.push("recipe header missing from stable prefix");

  if (fails.length > 0) return { pass: false, reason: fails.join("; ") };
  return { pass: true };
}
