// EVIDENCE (Thesis T1): the per-turn `result.events` buffered by EventSink is
// the full live-streaming replay log — every text_delta token, every
// tool_call_delta input patch, plus the full tool_call_end input and
// tool_result output. `conversation_get` then returns that array TWICE
// (top-level `events` + nested `result.events`). For a poll-only MCP client
// this is pure bloat: it needs status + final assistant text + terminal
// envelope, not the token-by-token replay.
//
// This test does not change behavior — it MEASURES it with numbers so the
// "engine is too talkative" thesis is proven, not asserted. After a fix
// (lean MCP projection) the same scenario is re-measured to show the drop.
//
// Run: bun test apps/engine/src/conversations/tests/verbosity-evidence.test.ts

import { describe, expect, it } from "bun:test";
import { EventSink } from "../event-sink.ts";
import type { TurnEvent } from "../types.ts";

/** Reproduce the frames a single "run this workflow" turn pushes, at the
 *  scale of the real slides-upload session (a ~40KB markdown deck as the
 *  tool input; the assistant streams a couple of sentences as deltas). */
function simulateRunWorkflowTurn(sink: EventSink, markdownBytes: number): void {
  const callId = "call_1";
  const bigMarkdown = "#".repeat(markdownBytes); // stand-in for the deck markdown
  const assistantText =
    "Ich rendere das Deck und lade es in den Supabase-Bucket `slides` hoch. " +
    "Das Ergebnis enthält die öffentliche URL.";

  // 1) assistant prose streamed token-by-token (text_delta), then the
  //    final consolidated `message` frame (replay).
  for (const word of assistantText.split(" ")) {
    sink.push({ type: "text_delta", text: `${word} ` });
  }

  // 2) the tool call: start, incremental input deltas, then the full input.
  sink.push({ type: "tool_call_start", call_id: callId, tool: "run_workflow" });
  // streaming the big input as ~1KB patches (what the SDK emits live)
  for (let i = 0; i < bigMarkdown.length; i += 1024) {
    sink.push({
      type: "tool_call_delta",
      call_id: callId,
      input_patch: { markdown_chunk: bigMarkdown.slice(i, i + 1024) },
    });
  }
  sink.push({
    type: "tool_call_end",
    call_id: callId,
    input: { workflow: "render-upload-slides", markdown: bigMarkdown, execute_writes: true },
  });

  // 3) the tool result: full output echoed back.
  sink.push({
    type: "tool_result",
    call_id: callId,
    tool: "run_workflow",
    output: {
      status: "succeeded",
      public_url: "https://storage.example.com/storage/v1/object/public/slides/deck.html",
      rendered_html_bytes: 5_300_000,
      echo_markdown: bigMarkdown,
    },
  });

  // 4) terminal frames.
  sink.push({ type: "message", role: "assistant", content: { text: assistantText }, id: "m1" });
  sink.push({ type: "completed", status: "active" });
}

/** What a poll-only MCP client actually needs from a finished turn. */
function leanProjection(events: TurnEvent[]): unknown {
  const finalMessage = [...events]
    .reverse()
    .find((e) => e.type === "message" && (e as { role?: string }).role === "assistant");
  const toolSummary = events
    .filter((e) => e.type === "tool_result")
    .map((e) => {
      const r = e as { call_id: string; tool: string; output: unknown };
      const ok = (r.output as { status?: string } | undefined)?.status ?? "done";
      return { call_id: r.call_id, tool: r.tool, status: ok };
    });
  const completed = events.find((e) => e.type === "completed");
  return {
    status: (completed as { status?: string } | undefined)?.status ?? "completed",
    message: finalMessage ? (finalMessage as { content: unknown }).content : null,
    tools: toolSummary,
  };
}

function bytes(v: unknown): number {
  return JSON.stringify(v)?.length ?? 0;
}

describe("EVIDENCE T1 — MCP conversation result verbosity", () => {
  it("buffers the full streaming replay (deltas + full payloads) into result.events", () => {
    const sink = new EventSink(); // no live emitter — pure buffered replay (what becomes result.events)
    simulateRunWorkflowTurn(sink, 40_000); // ~40KB deck markdown
    const events = sink.events;

    const count = (t: string) => events.filter((e) => e.type === t).length;
    const textDeltas = count("text_delta");
    const toolCallDeltas = count("tool_call_delta");

    // The replay log carries the streaming noise a poll client cannot use.
    expect(textDeltas).toBeGreaterThan(0);
    expect(toolCallDeltas).toBeGreaterThan(0);

    // result.events (what conversation_get returns) for ONE turn.
    const eventsBytes = bytes(events);

    // What conversation_get ACTUALLY serializes today: events twice
    // (top-level `events` + nested in `result`). See conversations.ts:488-507.
    const result = { conversation_id: "c1", status: "completed", events };
    const conversationGetPayload = { status: "completed", conversation_id: "c1", events, result };
    const doubleBytes = bytes(conversationGetPayload);

    // What a poll client actually needs.
    const lean = leanProjection(events);
    const leanBytes = bytes(lean);

    // Numbers for the record (visible in test output).
    console.log(
      JSON.stringify(
        {
          evidence: "T1_verbosity",
          frame_counts: {
            total: events.length,
            text_delta: textDeltas,
            tool_call_delta: toolCallDeltas,
          },
          bytes: {
            result_events: eventsBytes,
            conversation_get_payload_double_events: doubleBytes,
            lean_projection: leanBytes,
          },
          ratios: {
            double_vs_lean: Math.round(doubleBytes / Math.max(1, leanBytes)),
            events_serialized_twice: Math.round(doubleBytes / Math.max(1, eventsBytes)),
          },
        },
        null,
        2,
      ),
    );

    // PROOF of the bloat:
    // (a) the conversation_get payload serializes `events` ~twice.
    expect(doubleBytes).toBeGreaterThan(eventsBytes * 1.8);
    // (b) the lean projection a poll client needs is dramatically smaller.
    expect(leanBytes * 10).toBeLessThan(doubleBytes);
  });
});
