import { describe, expect, test } from "bun:test";
import type { TurnEvent } from "../types.ts";
import { buildNextSuggestionFrame } from "./suggest-next-emitter.ts";

const events: ReadonlyArray<TurnEvent> = [
  { type: "message", role: "user", content: { text: "should I commit?" } },
  {
    type: "message",
    role: "assistant",
    content: { text: "All set. Want me to commit and push it?" },
  },
  { type: "completed", status: "active" },
];

describe("buildNextSuggestionFrame", () => {
  test("emits an offer-detected frame for the canonical 'Want me to X?' case", async () => {
    const frame = await buildNextSuggestionFrame({
      tenant_id: "t",
      conversation_id: "c",
      events,
    });
    expect(frame.type).toBe("next_suggestion");
    if (frame.type !== "next_suggestion") throw new Error("unreachable");
    expect(frame.suggestion).toBe("commit and push it");
    expect(frame.reason).toBe("offer-detected");
    expect(frame.kind).toBe("text");
  });

  test("client_suppress short-circuits to a null frame with reason: 'client-suppress'", async () => {
    const frame = await buildNextSuggestionFrame({
      tenant_id: "t",
      conversation_id: "c",
      events,
      client_suppress: true,
    });
    if (frame.type !== "next_suggestion") throw new Error("unreachable");
    expect(frame.suggestion).toBeNull();
    expect(frame.reason).toBe("client-suppress");
  });

  test("model_invoker override is honored when offer-parse misses", async () => {
    const noOfferEvents: ReadonlyArray<TurnEvent> = [
      { type: "message", role: "user", content: { text: "fix the bug" } },
      { type: "message", role: "assistant", content: { text: "Bug fixed. Tests are green." } },
      { type: "completed", status: "active" },
    ];
    const frame = await buildNextSuggestionFrame({
      tenant_id: "t",
      conversation_id: "c",
      events: noOfferEvents,
      model_invoker: async () => ({ text: "commit this" }),
    });
    if (frame.type !== "next_suggestion") throw new Error("unreachable");
    expect(frame.suggestion).toBe("commit this");
    expect(frame.reason).toBe("model");
    expect(frame.kind).toBe("text");
  });

  test("loaded_skills routes the offer-skill slash variant", async () => {
    const skillEvents: ReadonlyArray<TurnEvent> = [
      { type: "message", role: "user", content: { text: "what's new?" } },
      {
        type: "message",
        role: "assistant",
        content: { text: "Want me to draft the release notes?" },
      },
      { type: "completed", status: "active" },
    ];
    const frame = await buildNextSuggestionFrame({
      tenant_id: "t",
      conversation_id: "c",
      events: skillEvents,
      loaded_skills: [{ slug: "release-notes", verbs: ["draft"] }],
    });
    if (frame.type !== "next_suggestion") throw new Error("unreachable");
    expect(frame.suggestion).toBe("/skill release-notes draft");
    expect(frame.kind).toBe("slash");
    expect(frame.reason).toBe("offer-skill");
  });

  test("empty conversation history produces a null frame with 'early-conversation'", async () => {
    const frame = await buildNextSuggestionFrame({
      tenant_id: "t",
      conversation_id: "c",
      events: [{ type: "completed", status: "active" }],
    });
    if (frame.type !== "next_suggestion") throw new Error("unreachable");
    expect(frame.suggestion).toBeNull();
    expect(frame.reason).toBe("early-conversation");
  });

  test("frame ordering: appended after `completed` produces message → completed → next_suggestion", async () => {
    const stream: TurnEvent[] = [
      { type: "message", role: "user", content: { text: "should I commit?" } },
      {
        type: "message",
        role: "assistant",
        content: { text: "All set. Want me to commit and push it?" },
      },
      { type: "completed", status: "active" },
    ];
    const frame = await buildNextSuggestionFrame({
      tenant_id: "t",
      conversation_id: "c",
      events: stream,
    });
    stream.push(frame);
    expect(stream.map((e) => e.type)).toEqual([
      "message",
      "message",
      "completed",
      "next_suggestion",
    ]);
    if (frame.type !== "next_suggestion") throw new Error("unreachable");
    expect(frame.suggestion).toBe("commit and push it");
  });

  test("budget_guard returning false collapses to 'budget-pressure' (no model call)", async () => {
    const noOfferEvents: ReadonlyArray<TurnEvent> = [
      { type: "message", role: "user", content: { text: "fix the bug" } },
      { type: "message", role: "assistant", content: { text: "Bug fixed." } },
      { type: "completed", status: "active" },
    ];
    let modelCalls = 0;
    const frame = await buildNextSuggestionFrame({
      tenant_id: "t",
      conversation_id: "c",
      events: noOfferEvents,
      budget_guard: () => false,
      model_invoker: async () => {
        modelCalls += 1;
        return { text: "x" };
      },
    });
    if (frame.type !== "next_suggestion") throw new Error("unreachable");
    expect(frame.reason).toBe("budget-pressure");
    expect(modelCalls).toBe(0);
  });

  test("multi-part content array flattens text parts so the offer parser sees them", async () => {
    const multiPartEvents = [
      { type: "message", role: "user", content: { text: "build a workflow" } },
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Connector saved. " },
          { type: "tool_use", id: "tu_1", name: "save_workflow_draft", input: {} },
          { type: "text", text: "Want me to commit and push it?" },
        ],
      },
      { type: "completed", status: "active" },
    ] as unknown as ReadonlyArray<TurnEvent>;

    const frame = await buildNextSuggestionFrame({
      tenant_id: "t",
      conversation_id: "c",
      events: multiPartEvents,
    });
    if (frame.type !== "next_suggestion") throw new Error("unreachable");
    expect(frame.suggestion).toBe("commit and push it");
    expect(frame.reason).toBe("offer-detected");
  });
});
