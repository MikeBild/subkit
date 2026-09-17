import { expect, test } from "bun:test";
import { pendingPrompt } from "./resume.ts";
import { resumeFormFields } from "./resume-form.ts";

test("resume projects a nested runner form without its executable payload", () => {
  const prompt = pendingPrompt({
    question: "Choose report scope",
    fields: [
      {
        name: "projects",
        label: "Projects",
        type: "text",
        required: true,
        default: "three projects",
        private: "not projected",
      },
    ],
    commit_intent: { kind: "run_workflow", payload: { private: "not projected" } },
  });
  expect(prompt.prompt?.fields).toEqual([
    {
      name: "projects",
      label: "Projects",
      type: "text",
      required: true,
      default: "three projects",
    },
  ]);
  expect(JSON.stringify(prompt)).not.toContain("not projected");
});
test("secret and malformed forms never become ordinary chat input", () => {
  expect(
    resumeFormFields([
      { name: "password", label: "Password", type: "password", default: "secret" },
    ]),
  ).toBeUndefined();
  expect(
    resumeFormFields([{ name: "token", label: "Token", type: "text", sensitive: true }]),
  ).toBeUndefined();
  expect(
    resumeFormFields([
      { name: "a", label: "A", type: "text" },
      { name: "a", label: "A", type: "text" },
    ]),
  ).toBeUndefined();
});
