import { describe, expect, test } from "bun:test";
import {
  answerForElicitation,
  createEngineClient,
  type FetchLike,
  parseCliArgs,
  projectTurn,
  ScenarioFileEntrySchema,
  type TurnEventLike,
} from "../live-authoring.ts";

const ENV = { SK_API_KEY: "key-under-test", SK_ENGINE_URL: "http://engine.test/" };

describe("parseCliArgs", () => {
  test("the key comes only from SK_API_KEY and never lands in the parsed arguments", () => {
    const parsed = parseCliArgs(["--engine-url", "http://e.test/"], ENV);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.engine_url).toBe("http://e.test");
    expect(JSON.stringify(parsed.args)).not.toContain("key-under-test");
    expect(parsed.args).toMatchObject({ trials: 1, cleanup: false, recipient: null });
  });

  test("--api-key is refused with a pointer to the environment variable", () => {
    const parsed = parseCliArgs(["--api-key", "secret"], ENV);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("SK_API_KEY");
    expect(parsed.error).not.toContain("secret");
  });

  test("a missing SK_API_KEY or engine url is an error, not a prompt", () => {
    expect(parseCliArgs([], { SK_ENGINE_URL: "http://e.test" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("SK_API_KEY"),
    });
    expect(parseCliArgs([], { SK_API_KEY: "k" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("--engine-url"),
    });
  });

  test("--trials, --cleanup, --recipient and --scenario are parsed; SK_EVAL_RECIPIENT is the fallback", () => {
    const parsed = parseCliArgs(
      ["--trials", "3", "--cleanup", "--scenario", "a, b", "--recipient", "ops@acme.test"],
      ENV,
    );
    expect(parsed).toMatchObject({
      ok: true,
      args: { trials: 3, cleanup: true, scenarios: ["a", "b"], recipient: "ops@acme.test" },
    });
    expect(parseCliArgs([], { ...ENV, SK_EVAL_RECIPIENT: "env@acme.test" })).toMatchObject({
      ok: true,
      args: { recipient: "env@acme.test" },
    });
  });

  test("--trials rejects zero, negatives and non-integers; unknown flags are errors", () => {
    expect(parseCliArgs(["--trials", "0"], ENV).ok).toBe(false);
    expect(parseCliArgs(["--trials", "1.5"], ENV).ok).toBe(false);
    expect(parseCliArgs(["--trials"], ENV)).toMatchObject({
      ok: false,
      error: "--trials needs a value",
    });
    expect(parseCliArgs(["--bogus", "x"], ENV)).toMatchObject({
      ok: false,
      error: "unknown argument --bogus",
    });
  });
});

describe("ScenarioFileEntrySchema", () => {
  const base = {
    slug: "local",
    goal: "do a thing",
    connectors: [],
    content_checks: [{ name: "x", pattern: "x" }],
  };

  test("requires kind and accepts answer_turns; expect_judge_block is no longer part of the shape", () => {
    expect(ScenarioFileEntrySchema.safeParse(base).success).toBe(false);
    const parsed = ScenarioFileEntrySchema.safeParse({
      ...base,
      kind: "clarification",
      answer_turns: ["answer"],
      expect_judge_block: true,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.kind).toBe("clarification");
    expect(parsed.data.answer_turns).toEqual(["answer"]);
    expect("expect_judge_block" in parsed.data).toBe(false);
  });
});

describe("projectTurn", () => {
  const events: TurnEventLike[] = [
    { type: "message", role: "user", content: "hi" },
    { type: "tool_call_start", call_id: "c1", tool: "list_connectors" },
    { type: "tool_call_end", call_id: "c1", input: { q: "mail" } },
    { type: "tool_result", call_id: "c1", tool: "list_connectors", output: { items: [] } },
    { type: "tool_call_start", call_id: "c2", tool: "ask_user_text" },
    { type: "tool_call_end", call_id: "c2", input: { question: "Who receives it?" } },
    { type: "text_delta", text: "I need " },
    { type: "text_delta", text: "one detail." },
    {
      type: "elicit_request",
      elicitation_id: "elic_1",
      tool_name: "ask_user_text",
      input: { question: "Who receives it?" },
    },
    { type: "completed", status: "awaiting_input", usage: { turn_tokens: 1200 } },
  ];

  test("joins start/end/result by call_id, concatenates text deltas and surfaces the elicitation", () => {
    const projected = projectTurn({
      conversation: { id: "conv" },
      events,
      status: "awaiting_input",
      pending_elicitation_id: "elic_1",
    });
    expect(projected.turn.tool_calls).toEqual([
      { call_id: "c1", tool: "list_connectors", input: { q: "mail" }, output: { items: [] } },
      {
        call_id: "c2",
        tool: "ask_user_text",
        input: { question: "Who receives it?" },
        output: undefined,
      },
    ]);
    expect(projected.turn.assistant_text).toBe("I need one detail.");
    expect(projected.turn.status).toBe("awaiting_input");
    expect(projected.turn.pending_elicitation_id).toBe("elic_1");
    expect(projected.tokens).toBe(1200);
    expect(projected.elicitation).toEqual({
      id: "elic_1",
      tool_name: "ask_user_text",
      input: { question: "Who receives it?" },
    });
  });

  test("a start without end or result is not counted; status falls back to the completed event", () => {
    const projected = projectTurn({
      events: [
        { type: "tool_call_start", call_id: "orphan", tool: "author_workflow" },
        { type: "message", role: "assistant", content: [{ type: "text", text: "done" }] },
        { type: "completed", status: "committed" },
      ],
      committed_workflow_id: "wf_1",
    });
    expect(projected.turn.tool_calls).toEqual([]);
    expect(projected.turn.assistant_text).toBe("done");
    expect(projected.turn.status).toBe("committed");
    expect(projected.turn.pending_elicitation_id).toBeNull();
    expect(projected.elicitation).toBeNull();
  });

  test("without an elicit_request event the pending elicitation is typed from the last ask_user_* call", () => {
    const projected = projectTurn({
      events: [
        { type: "tool_call_end", call_id: "c9", tool: "ask_user_form", input: { fields: [] } },
        { type: "tool_result", call_id: "c9", tool: "ask_user_form", output: {} },
      ],
      status: "awaiting_input",
      pending_elicitation_id: "elic_9",
    });
    expect(projected.elicitation).toEqual({
      id: "elic_9",
      tool_name: "ask_user_form",
      input: { fields: [] },
    });
  });
});

describe("answerForElicitation", () => {
  const ANSWER = "Send it to ops@acme.test; the report is the list of my droplets.";

  test("ask_user_text → {text}", () => {
    expect(answerForElicitation("ask_user_text", { question: "?" }, ANSWER)).toEqual({
      text: ANSWER,
    });
    expect(answerForElicitation(null, undefined, ANSWER)).toEqual({ text: ANSWER });
  });

  test("ask_user_form → {values} with the e-mail routed to recipient-like fields and typed defaults elsewhere", () => {
    expect(
      answerForElicitation(
        "ask_user_form",
        {
          fields: [
            { name: "to", label: "Recipient e-mail", type: "text", required: true },
            { name: "source", label: "Data source", type: "text" },
            { name: "format", label: "Format", type: "select", options: ["html", "text"] },
            { name: "days", label: "Days", type: "number" },
            { name: "include_specs", label: "Include specs", type: "boolean" },
            {
              name: "regions",
              label: "Regions",
              type: "multi",
              options: [{ value: "fra1", label: "FRA" }],
            },
          ],
        },
        ANSWER,
      ),
    ).toEqual({
      values: {
        to: "ops@acme.test",
        source: ANSWER,
        format: "html",
        days: 0,
        include_specs: true,
        regions: ["fra1"],
      },
    });
  });

  test("ask_user_choice → {value}, ask_user_multi → {values}, ask_user_confirm declines", () => {
    expect(
      answerForElicitation(
        "ask_user_choice",
        { options: [{ value: "a", label: "A" }, "b"] },
        ANSWER,
      ),
    ).toEqual({ value: "a" });
    expect(answerForElicitation("ask_user_multi", { options: ["x", "y"] }, ANSWER)).toEqual({
      values: ["x"],
    });
    expect(answerForElicitation("ask_user_confirm", { question: "Proceed?" }, ANSWER)).toEqual({
      confirmed: false,
      reason: ANSWER,
    });
  });
});

describe("createEngineClient", () => {
  test("sends the bearer key only in the authorization header of the one request", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), auth: headers.get("authorization") });
      return new Response("{}", { status: 200 });
    };
    const client = createEngineClient("http://engine.test///", "key-under-test", fetchImpl);
    expect(client.engine_url).toBe("http://engine.test");
    await client.request("/v1/conversations", { method: "POST", body: "{}" });
    expect(seen).toEqual([
      { url: "http://engine.test/v1/conversations", auth: "Bearer key-under-test" },
    ]);
    expect(JSON.stringify(client)).not.toContain("key-under-test");
  });
});
