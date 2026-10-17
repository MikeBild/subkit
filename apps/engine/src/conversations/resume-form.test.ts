import { expect, test } from "bun:test";
import { pendingPrompt } from "./resume.ts";
import { ResumeFormFieldSchema, resumeFormFields } from "./resume-form.ts";
import { unrenderableFormResult } from "./tools/ask-user/common.ts";
import { askUserFormTool, FORM_FIELD_TYPES, type FormFieldType } from "./tools/ask-user/form.ts";

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

test("a credential form projects its masked field as a definition, never a value", () => {
  const prompt = pendingPrompt({
    question: "Enter the Metabase API key",
    fields: [{ name: "token", label: "API key", type: "password", sensitive: true }],
    commit_intent: { kind: "save_connector_draft", payload: { credential: { mode: "bearer" } } },
  });
  expect(prompt.prompt?.fields).toEqual([
    { name: "token", label: "API key", type: "password", sensitive: true },
  ]);
  expect(prompt.prompt?.intent_kind).toBe("save_connector_draft");
});

test("secret fields never carry a default; malformed forms stay unprojected", () => {
  const projected = resumeFormFields([
    { name: "password", label: "Password", type: "password", default: "secret-default" },
    { name: "token", label: "Token", type: "text", sensitive: true, default: "secret-token" },
    { name: "host", label: "Host", type: "text", default: "db.example.test" },
  ]);
  expect(projected).toEqual([
    { name: "password", label: "Password", type: "password" },
    { name: "token", label: "Token", type: "text", sensitive: true },
    { name: "host", label: "Host", type: "text", default: "db.example.test" },
  ]);
  expect(JSON.stringify(projected)).not.toContain("secret-");
  expect(
    resumeFormFields([
      { name: "a", label: "A", type: "text" },
      { name: "a", label: "A", type: "text" },
    ]),
  ).toBeUndefined();
});

const sample: Record<FormFieldType, Record<string, unknown>> = {
  text: {},
  number: {},
  boolean: {},
  select: { options: [{ value: "a", label: "A" }] },
  password: {},
  json: {},
  multi: { options: ["a", "b"] },
};

test("every ask_user_form field type is projectable by the resume form (tool ⊆ resume)", () => {
  expect(ResumeFormFieldSchema.shape.type.options).toEqual(
    expect.arrayContaining([...FORM_FIELD_TYPES]),
  );
  for (const type of FORM_FIELD_TYPES) {
    for (const sensitive of [undefined, true]) {
      const field = {
        name: `f_${type}`,
        label: type,
        type,
        required: true,
        placeholder: "hint",
        ...(sensitive ? { sensitive } : {}),
        ...sample[type],
      };
      const args = askUserFormTool.inputSchema.parse({ question: "Q", fields: [field] }) as {
        fields: unknown[];
      };
      const projected = resumeFormFields(args.fields);
      expect({ type, sensitive, projected: projected?.[0]?.type }).toEqual({
        type,
        sensitive,
        projected: type,
      });
      expect(unrenderableFormResult(args)).toBeNull();
    }
  }
});

test("a form the reader cannot render is refused at call time with a recovery hint", () => {
  const refused = unrenderableFormResult({
    question: "Q",
    fields: [
      { name: "a", label: "A", type: "text" },
      { name: "a", label: "A again", type: "text" },
    ],
  });
  expect(refused).toMatchObject({
    ok: false,
    error_code: "form_not_renderable",
    next_best_actions: ["ask_user_form"],
    message: expect.stringContaining("unique name"),
  });
});

test("resume projects the stored subjects a confirmation concerns and drops everything else", () => {
  const prompt = pendingPrompt({
    question: "Policy requires confirmation before running reject_skill_candidate. Proceed?",
    commit_intent: { kind: "execute_confirmed_tool_call" },
    pending_output: {
      titles: ["Model supplied title"],
      candidate_ids: ["hidden"],
      subjects: [
        { id: "a", title: "Chord analysis", status: "proposed" },
        { id: "b", title: "  Retention  ", status: "proposed" },
        { id: "c", title: null, status: "not_found" },
        7,
      ],
    },
  });
  expect(prompt.prompt?.subjects).toEqual(["Chord analysis", "Retention", "c (not found)"]);
  expect(
    pendingPrompt({ question: "Proceed?", pending_output: { titles: ["Only the model"] } }).prompt,
  ).not.toHaveProperty("subjects");
  expect(
    pendingPrompt({ question: "Proceed?", pending_output: { subjects: [] } }).prompt,
  ).not.toHaveProperty("subjects");
});

test("resume shows every subject of a large batch", () => {
  const subjects = Array.from({ length: 45 }, (_, i) => ({
    id: `id-${i}`,
    title: `Candidate ${i}`,
    status: "proposed",
  }));
  const prompt = pendingPrompt({ question: "Proceed?", pending_output: { subjects } });
  expect(prompt.prompt?.subjects).toHaveLength(45);
});

test("resume shows the approval target and the body excerpt after the subject", () => {
  const draft = pendingPrompt({
    question: "Proceed?",
    pending_output: {
      subjects: [{ id: "a", title: "Retry budget", status: "proposed" }],
      target: { kind: "skill_draft" },
      body_excerpt: "Retry twice, then stop.",
    },
  });
  expect(draft.prompt?.subjects).toEqual([
    "Retry budget",
    "Target: new draft skill (needs activation)",
    "Retry twice, then stop.",
  ]);
  const fact = pendingPrompt({
    question: "Proceed?",
    pending_output: {
      subjects: [{ id: "a", title: "Rota", status: "proposed" }],
      target: { kind: "knowledge", knowledge_source_name: "Learnings · ops" },
    },
  });
  expect(fact.prompt?.subjects).toEqual(["Rota", "Target: knowledge source Learnings · ops"]);
});
