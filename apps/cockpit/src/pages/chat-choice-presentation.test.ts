import { expect, test } from "bun:test";
import type { ChatChoice } from "./chat-choice";
import { chatChoicePresentation } from "./chat-choice-presentation";

const legacy: ChatChoice = {
  id: "pending",
  toolCallId: "call",
  expiresAt: "2099-01-01T00:00:00Z",
  question:
    "Die Engine verlangt ein Dry-Run-Preview, bevor der Draft gespeichert werden kann. Write-Schritte (call_generate, call_publish, call_accept) werden dabei gehalten und nicht ausgeführt. Wie soll ich vorgehen?",
  options: [
    { value: "dryrun", label: "Dry-Run durchführen" },
    { value: "force", label: "force_commit verwenden" },
    { value: "cancel", label: "Abbrechen" },
  ],
};

test("old preparation question gains readable copy without changing its response binding", () => {
  const shown = chatChoicePresentation(legacy, (key) => key);
  expect(shown.question).toBe("chat.choice.preparation.question");
  expect(shown.options.map((item) => item.label)).toEqual([
    "chat.choice.preparation.dryrun",
    "chat.choice.preparation.force",
    "chat.choice.preparation.cancel",
  ]);
  expect(shown.options.map((item) => item.value)).toEqual(["dryrun", "force", "cancel"]);
  expect(shown.id).toBe(legacy.id);
  expect(shown.toolCallId).toBe(legacy.toolCallId);
  expect(shown.expiresAt).toBe(legacy.expiresAt);
  expect(legacy.options[1]?.label).toBe("force_commit verwenden");
});

test("unrelated and changed questions keep their actual meaning", () => {
  for (const choice of [
    { ...legacy, question: "Which production action should run?" },
    { ...legacy, options: [{ value: "force", label: "Publish" }, ...legacy.options.slice(1)] },
  ]) {
    expect(chatChoicePresentation(choice, (key) => key)).toBe(choice);
  }
});
