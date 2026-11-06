import { basePromptFor } from "../../src/llm/runtime/context-assembler.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  required_phrases: string[];
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const prompt = await basePromptFor("converse", "sk_interactive");
  const promptText = [prompt.content, prompt.volatile].filter(Boolean).join("\n\n");
  const input = fixture.input as Input;
  const missing = input.required_phrases.filter((phrase) => !promptText.includes(phrase));
  if (missing.length > 0) {
    return {
      pass: false,
      reason: `missing grounded-history prompt phrase(s): ${missing.join(", ")}`,
    };
  }
  return { pass: true };
}
