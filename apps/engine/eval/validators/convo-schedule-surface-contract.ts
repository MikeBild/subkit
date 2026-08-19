import { planTurnRouting } from "../../src/conversations/turn-routing.ts";
import { basePromptFor } from "../../src/llm/core/context-assembler.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  how_message: string;
  write_message: string;
  list_message: string;
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  const prompt = await basePromptFor("converse", "sk_interactive");
  const promptText = [prompt.content, prompt.volatile].filter(Boolean).join("\n\n");
  const failures: string[] = [];

  if (!promptText.includes("tenant_create_schedule")) {
    failures.push("prompt is missing tenant_create_schedule guidance");
  }
  if (!promptText.includes("every:<seconds>")) {
    failures.push("prompt is missing every:<seconds> guidance");
  }

  const howPlan = planTurnRouting({
    draft: { workflow: { name: "draft", steps: [] } } as never,
    user_message: input.how_message,
  });
  if (howPlan.intent !== "surface_help") {
    failures.push(`how-message intent expected surface_help, got ${howPlan.intent}`);
  }
  if (howPlan.action.includes("not exposed")) {
    failures.push("how-message still claims schedules are not exposed");
  }

  const writePlan = planTurnRouting({
    draft: { workflow: { name: "draft", steps: [] } } as never,
    user_message: input.write_message,
  });
  if (writePlan.intent !== "tenant_write") {
    failures.push(`write-message intent expected tenant_write, got ${writePlan.intent}`);
  }
  if (!writePlan.action.includes("create_schedule")) {
    failures.push("write-message does not ground to create_schedule");
  }

  const listPlan = planTurnRouting({
    draft: { workflow: { name: "draft", steps: [] } } as never,
    user_message: input.list_message,
  });
  if (listPlan.intent !== "tenant_read") {
    failures.push(`list-message intent expected tenant_read, got ${listPlan.intent}`);
  }
  if (!listPlan.action.includes("list_schedules")) {
    failures.push("list-message does not ground to list_schedules");
  }

  return failures.length === 0 ? { pass: true } : { pass: false, reason: failures.join("; ") };
}
