import { describe, expect, test } from "bun:test";
import { promptSizePerStep, readPromptSizeReference } from "../runner.ts";

const reference = { prompt_tokens_per_chat_step: 72000, target_prompt_tokens_per_chat_step: 30000 };

describe("prompt size per chat step in the eval report", () => {
  test("collects per-step tokens with the single-skill arm and the PROD reference", () => {
    const report = promptSizePerStep(
      [
        {
          name: "authoring-prompt-size-per-step",
          flow: "converse",
          pass: true,
          duration_ms: 1,
          metrics: {
            prompt_tokens_step_build: 9000,
            single_skill_prompt_tokens_step_build: 20000,
            prompt_tokens_step_save: 11000,
            single_skill_prompt_tokens_step_save: 20000,
            prompt_tokens_step_mean: 10000,
            prompt_tokens_step_max: 11000,
          },
        },
        { name: "other", flow: "converse", pass: true, duration_ms: 1, metrics: { rules: 3 } },
      ],
      reference,
    );
    expect(report).toEqual({
      steps: [
        {
          item: "authoring-prompt-size-per-step",
          step: "build",
          tokens: 9000,
          single_skill_tokens: 20000,
        },
        {
          item: "authoring-prompt-size-per-step",
          step: "save",
          tokens: 11000,
          single_skill_tokens: 20000,
        },
      ],
      mean_tokens: 10000,
      max_tokens: 11000,
      mean_single_skill_tokens: 20000,
      prompt_tokens_per_chat_step: 72000,
      target_prompt_tokens_per_chat_step: 30000,
    });
  });

  test("no step metrics means no prompt size section", () => {
    expect(
      promptSizePerStep([{ name: "x", flow: "infra", pass: true, duration_ms: 1 }], reference),
    ).toBeNull();
  });

  test("reads the per-step reference and target from the PROD baseline", () => {
    expect(
      readPromptSizeReference(
        JSON.stringify({
          tokens: { prompt_tokens_per_chat_step: 72000 },
          targets: { prompt_tokens_per_chat_step: 30000 },
        }),
      ),
    ).toEqual(reference);
    expect(readPromptSizeReference(null)).toEqual({
      prompt_tokens_per_chat_step: null,
      target_prompt_tokens_per_chat_step: null,
    });
  });
});
