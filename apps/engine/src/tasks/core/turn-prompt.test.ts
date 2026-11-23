import { describe, expect, test } from "bun:test";
import { decideTurn } from "../../conversations/core/fast-path.ts";
import {
  TASK_RUN_CONTINUATION_MESSAGE,
  TASK_RUN_LANGUAGE_INSTRUCTIONS,
  TASK_RUN_REJECTION_NOTICE,
  taskRunTurnKind,
  taskRunTurnPrompt,
} from "./turn-prompt.ts";

describe("taskRunTurnKind", () => {
  test.each([
    [null, 0, "continue"],
    [null, 4, "continue"],
    [3, 4, "continue"],
    [5, 4, "continue"],
    [4, 4, "after_rejection"],
    [0, 0, "after_rejection"],
  ] as const)("rejected at %p, playbook at %p: %s", (rejected, last, kind) => {
    expect(
      taskRunTurnKind({ rejected_playbook_revision: rejected, last_playbook_revision: last }),
    ).toBe(kind);
  });
});

describe("taskRunTurnPrompt", () => {
  test.each([
    ["de", "continue", [TASK_RUN_CONTINUATION_MESSAGE, TASK_RUN_LANGUAGE_INSTRUCTIONS.de]],
    ["en", "continue", [TASK_RUN_CONTINUATION_MESSAGE, TASK_RUN_LANGUAGE_INSTRUCTIONS.en]],
    [
      "de",
      "after_rejection",
      [TASK_RUN_CONTINUATION_MESSAGE, TASK_RUN_REJECTION_NOTICE, TASK_RUN_LANGUAGE_INSTRUCTIONS.de],
    ],
    [
      "en",
      "after_rejection",
      [TASK_RUN_CONTINUATION_MESSAGE, TASK_RUN_REJECTION_NOTICE, TASK_RUN_LANGUAGE_INSTRUCTIONS.en],
    ],
  ] as const)("%s, %s: the language comes last", (language, kind, lines) => {
    const prompt = taskRunTurnPrompt(language, kind);
    expect(prompt.split("\n")).toEqual([...lines]);
    expect(decideTurn(prompt)).toEqual([]);
  });

  test("German asks for German and du, English for English only", () => {
    expect(TASK_RUN_LANGUAGE_INSTRUCTIONS.de).toStartWith("Language: German.");
    expect(TASK_RUN_LANGUAGE_INSTRUCTIONS.de).toContain("in German");
    expect(TASK_RUN_LANGUAGE_INSTRUCTIONS.de).toContain('"du", never "Sie"');
    expect(TASK_RUN_LANGUAGE_INSTRUCTIONS.en).toStartWith("Language: English.");
    expect(TASK_RUN_LANGUAGE_INSTRUCTIONS.en).toContain("in English");
    expect(TASK_RUN_LANGUAGE_INSTRUCTIONS.en).not.toContain("German");
    expect(TASK_RUN_CONTINUATION_MESSAGE.length).toBeLessThan(200);
    expect(TASK_RUN_CONTINUATION_MESSAGE).toStartWith("Continue working on the task.");
    expect(TASK_RUN_CONTINUATION_MESSAGE).toEndWith("ending the round hands it over.");
    expect(decideTurn(TASK_RUN_CONTINUATION_MESSAGE)).toEqual([]);
    expect(TASK_RUN_REJECTION_NOTICE).toStartWith("The person rejected the result.");
  });
});
