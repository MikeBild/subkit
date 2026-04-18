import { splitPromptIntoBlocks } from "../../src/llm/core/cache-blocks.ts";
import type { EnhancedPrompt } from "../../src/llm/types.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

export function validate(fixture: FixtureRecord): ValidationResult {
  const { system } = fixture.input as { system: string };
  const prompt: EnhancedPrompt = {
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
  const blocks = splitPromptIntoBlocks(prompt, "converse");
  const fails: string[] = [];
  if (!blocks.stable.includes("# Skill: Test")) fails.push("skill not in stable");
  if (!blocks.stable.includes("## Doc:")) fails.push("doc not in stable");
  if (!blocks.stable.includes("## Knowledge:")) fails.push("knowledge not in stable");
  if (!blocks.volatile.includes("# User memory")) fails.push("memory not in volatile");
  if (!blocks.volatile.includes("## Prior failure:")) fails.push("failure not in volatile");
  if (blocks.stable.includes("User memory")) fails.push("memory leaked into stable");
  if (blocks.stable.includes("Prior failure")) fails.push("failure leaked into stable");
  if (fails.length > 0) return { pass: false, reason: fails.join("; ") };
  return { pass: true };
}
