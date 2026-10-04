import { describe, expect, it } from "bun:test";
import { EventSink } from "../event-sink.ts";
import type { TurnEvent } from "../types.ts";

function simulateRunWorkflowTurn(sink: EventSink, markdownBytes: number): void {
  const callId = "call_1";
  const bigMarkdown = "#".repeat(markdownBytes);
  const assistantText =
    "Ich rendere das Deck und lade es in den Supabase-Bucket `slides` hoch. " +
    "Das Ergebnis enthält die öffentliche URL.";

  for (const word of assistantText.split(" ")) {
    sink.push({ type: "text_delta", text: `${word} ` });
  }

  sink.push({ type: "tool_call_start", call_id: callId, tool: "run_workflow" });
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

  sink.push({ type: "message", role: "assistant", content: { text: assistantText }, id: "m1" });
  sink.push({ type: "completed", status: "active" });
}

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
    const sink = new EventSink();
    simulateRunWorkflowTurn(sink, 40_000);
    const events = sink.events;

    const count = (t: string) => events.filter((e) => e.type === t).length;
    const textDeltas = count("text_delta");
    const toolCallDeltas = count("tool_call_delta");

    expect(textDeltas).toBeGreaterThan(0);
    expect(toolCallDeltas).toBeGreaterThan(0);

    const eventsBytes = bytes(events);

    const result = { conversation_id: "c1", status: "completed", events };
    const conversationGetPayload = { status: "completed", conversation_id: "c1", events, result };
    const doubleBytes = bytes(conversationGetPayload);

    const lean = leanProjection(events);
    const leanBytes = bytes(lean);

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

    expect(doubleBytes).toBeGreaterThan(eventsBytes * 1.8);
    expect(leanBytes * 10).toBeLessThan(doubleBytes);
  });
});
