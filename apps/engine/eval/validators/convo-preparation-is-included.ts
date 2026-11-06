import { basePromptFor } from "../../src/llm/runtime/context-assembler.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as { required_phrases: string[] };
  for (const surface of ["web", "mcp"] as const) {
    const prompt = await basePromptFor("converse", surface);
    const text = [prompt.content, prompt.volatile].filter(Boolean).join("\n\n");
    const missing = input.required_phrases.filter((phrase) => !text.includes(phrase));
    if (missing.length) return { pass: false, reason: `${surface}: missing ${missing.join(", ")}` };
    if (text.includes("structured field labels stay verbatim")) {
      return { pass: false, reason: `${surface}: technical-label rule still present` };
    }
  }
  return { pass: true };
}
