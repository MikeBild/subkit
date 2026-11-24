import { describe, expect, test } from "bun:test";
import { rewriteStoredModelSteps } from "./model-step-rewrite.ts";

const people = {
  type: "object",
  required: ["people"],
  properties: { people: { type: "array" } },
};

function wf(steps: unknown[], extra: Record<string, unknown> = {}) {
  return { name: "w", steps, ...extra };
}

describe("rewriteStoredModelSteps", () => {
  test("a structured Responses call becomes a model step", () => {
    const rewrite = rewriteStoredModelSteps(
      wf([
        {
          kind: "request",
          id: "extract",
          method: "POST",
          url: "${connector.openai.base_url}/responses",
          timeout_ms: 30000,
          body: {
            model: "gpt-4.1-mini",
            instructions: "Be exact.",
            input: "Extract people from ${input.text}",
            max_output_tokens: 99999,
            response_format: { type: "json_schema", json_schema: { name: "p", schema: people } },
          },
        },
      ]),
    );
    expect(rewrite.changed).toBe(true);
    expect(rewrite.changes).toEqual([{ step_id: "extract" }]);
    expect((rewrite.dag as { steps: unknown[] }).steps[0]).toEqual({
      kind: "model",
      id: "extract",
      timeout_ms: 30000,
      prompt: "Extract people from ${input.text}",
      system: "Be exact.",
      output_schema: people,
      max_output_tokens: 32000,
    });
  });

  test("a messages call with a system field and one user message is rewritten", () => {
    const rewrite = rewriteStoredModelSteps(
      wf([
        {
          kind: "request",
          id: "classify",
          method: "POST",
          url: "https://api.anthropic.com/v1/messages",
          body: {
            system: "Sort messages.",
            max_tokens: 4096,
            messages: [{ role: "user", content: "Classify ${input.text}" }],
            output_config: { format: { type: "json_schema", schema: people } },
          },
        },
      ]),
    );
    expect((rewrite.dag as { steps: unknown[] }).steps[0]).toEqual({
      kind: "model",
      id: "classify",
      prompt: "Classify ${input.text}",
      system: "Sort messages.",
      output_schema: people,
      max_output_tokens: 4096,
    });
  });

  test("system messages of a chat call join the system text, a non-text one keeps the request", () => {
    const chat = (id: string, system: unknown) => ({
      kind: "request",
      id,
      method: "POST",
      url: "https://api.openai.com/v1/chat/completions",
      body: {
        messages: [
          { role: "system", content: system },
          { role: "user", content: "Sort ${input.text}" },
        ],
        response_format: { json_schema: { schema: people } },
      },
    });
    const rewrite = rewriteStoredModelSteps(wf([chat("sort", "Be brief."), chat("odd", 7)]));
    expect((rewrite.dag as { steps: unknown[] }).steps[0]).toMatchObject({
      kind: "model",
      id: "sort",
      prompt: "Sort ${input.text}",
      system: "Be brief.",
    });
    expect(rewrite.skipped).toEqual([{ step_id: "odd", reason: "not_one_user_message" }]);
  });

  test("steps that cannot be carried over keep their request form with a reason", () => {
    const chat = (id: string, body: Record<string, unknown>, extra = {}) => ({
      kind: "request",
      id,
      method: "POST",
      url: "https://api.openai.com/v1/chat/completions",
      body,
      ...extra,
    });
    const schema = { response_format: { json_schema: { schema: people } } };
    const rewrite = rewriteStoredModelSteps(
      wf([
        chat("free_text", { messages: [{ role: "user", content: "hi" }] }),
        chat("two_turns", {
          ...schema,
          messages: [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
            { role: "user", content: "c" },
          ],
        }),
        chat("read_later", { ...schema, messages: [{ role: "user", content: "x" }] }),
        chat(
          "selected",
          { ...schema, messages: [{ role: "user", content: "x" }] },
          { data_selector: "$.choices" },
        ),
        { kind: "transform", id: "use", expression: "return input.scope.read_later.data;" },
        { kind: "request", id: "other", method: "GET", url: "https://example.com" },
      ]),
    );
    expect(rewrite.changed).toBe(false);
    expect(rewrite.skipped).toEqual([
      { step_id: "free_text", reason: "no_output_schema" },
      { step_id: "two_turns", reason: "not_one_user_message" },
      { step_id: "read_later", reason: "output_referenced" },
      { step_id: "selected", reason: "request_only_fields" },
    ]);
  });

  test("a reference from the workflow output transform also keeps the request form", () => {
    const rewrite = rewriteStoredModelSteps(
      wf(
        [
          {
            kind: "request",
            id: "ask",
            method: "POST",
            url: "https://api.openai.com/v1/responses",
            body: { input: "x", text: { format: { type: "json_schema", schema: people } } },
          },
        ],
        { output_transform: "ask.data" },
      ),
    );
    expect(rewrite.skipped).toEqual([{ step_id: "ask", reason: "output_referenced" }]);
  });
  test("requests that are not provider calls stay untouched without a reason", () => {
    const rewrite = rewriteStoredModelSteps(
      wf([
        { kind: "request", id: "broken", method: "POST", url: "not a url", body: {} },
        {
          kind: "request",
          id: "embed",
          method: "POST",
          url: "https://api.openai.com/v1/embeddings",
          body: { input: "x" },
        },
      ]),
    );
    expect(rewrite.changed).toBe(false);
    expect(rewrite.skipped).toEqual([]);
  });
});
