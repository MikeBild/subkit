import { describe, expect, it } from "bun:test";
import {
  projectTurnEnvelopeForClient,
  projectTurnEventsForClient,
} from "../capabilities/turn-projection.ts";

function bytes(v: unknown): number {
  return JSON.stringify(v)?.length ?? 0;
}

function rawTurnEnvelope(markdownBytes: number) {
  const bigMarkdown = "#".repeat(markdownBytes);
  const events: unknown[] = [];
  for (const w of "Ich rendere und lade das Deck hoch.".split(" ")) {
    events.push({ type: "text_delta", text: `${w} ` });
  }
  events.push({ type: "tool_call_start", call_id: "c1", tool: "run_workflow" });
  for (let i = 0; i < bigMarkdown.length; i += 1024) {
    events.push({
      type: "tool_call_delta",
      call_id: "c1",
      input_patch: bigMarkdown.slice(i, i + 1024),
    });
  }
  events.push({ type: "tool_call_end", call_id: "c1", input: { markdown: bigMarkdown } });
  events.push({
    type: "tool_log",
    call_id: "c1",
    tool: "run_workflow",
    level: "info",
    message: "uploading",
    ts: "t",
  });
  events.push({
    type: "tool_result",
    call_id: "c1",
    tool: "run_workflow",
    output: { status: "succeeded", public_url: "https://x/deck.html", echo: bigMarkdown },
  });
  events.push({ type: "message", role: "assistant", content: { text: "Hochgeladen ✓" }, id: "m1" });
  events.push({ type: "completed", status: "active" });
  return { conversation_id: "conv1", status: "active" as const, events };
}

describe("turn-projection — lean MCP poll envelope (T1 fix)", () => {
  it("drops live-streaming replay frames", () => {
    const lean = projectTurnEventsForClient(rawTurnEnvelope(40_000).events);
    const types = new Set(lean.map((e) => (e as { type?: string }).type));
    for (const dropped of [
      "text_delta",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "tool_log",
      "activity",
    ]) {
      expect(types.has(dropped)).toBe(false);
    }
  });

  it("preserves the terminal/meaningful frames", () => {
    const lean = projectTurnEventsForClient(rawTurnEnvelope(40_000).events);
    const types = new Set(lean.map((e) => (e as { type?: string }).type));
    expect(types.has("message")).toBe(true);
    expect(types.has("tool_result")).toBe(true);
    expect(types.has("completed")).toBe(true);
    const msg = lean.find((e) => (e as { type?: string }).type === "message") as {
      content: { text: string };
    };
    expect(msg.content.text).toBe("Hochgeladen ✓");
  });

  it("truncates oversized tool_result output and attaches a raw_ref pointer", () => {
    const lean = projectTurnEventsForClient(rawTurnEnvelope(40_000).events);
    const tr = lean.find((e) => (e as { type?: string }).type === "tool_result") as Record<
      string,
      unknown
    >;
    expect(bytes(tr.output)).toBeLessThan(5_000);
    expect(typeof tr.output_raw_ref).toBe("string");
  });

  it("collapses the envelope from ~125KB to a small bounded payload", () => {
    const raw = rawTurnEnvelope(40_000);
    const rawBytes = bytes(raw);
    const lean = projectTurnEnvelopeForClient(raw);
    const leanBytes = bytes(lean);
    console.log(
      JSON.stringify({
        evidence: "T1_fix",
        raw_envelope_bytes: rawBytes,
        lean_envelope_bytes: leanBytes,
        reduction_ratio: Math.round(rawBytes / Math.max(1, leanBytes)),
      }),
    );
    expect(rawBytes).toBeGreaterThan(100_000);
    expect(leanBytes).toBeLessThan(8_000);
    const huge = projectTurnEnvelopeForClient(rawTurnEnvelope(5_000_000));
    expect(bytes(huge)).toBeLessThan(8_000);
  });

  it("retires a resolved input prompt from a persisted awaiting-input snapshot", () => {
    const elicitationId = "elicitation-expired";
    const raw = {
      conversation_id: "conv1",
      status: "awaiting_input" as const,
      pending_elicitation_id: elicitationId,
      events: [
        {
          type: "tool_result",
          output: { status: "awaiting_input", elicitation_id: elicitationId },
        },
        {
          type: "elicit_request",
          elicitation_id: elicitationId,
          input: { setup_url: "https://engine.invalid/credentials/setup?grant=secret" },
        },
        { type: "completed", status: "awaiting_input" },
        { type: "next_suggestion", suggestion: "retry ask_user_form" },
      ],
    };

    const projected = projectTurnEnvelopeForClient(raw, { pending_elicitation_id: null });

    expect(projected.status).toBe("active");
    expect(projected.pending_elicitation_id).toBeUndefined();
    expect(projected.events.map((event) => (event as { type?: string }).type)).toEqual([
      "tool_result",
      "completed",
    ]);
    expect(JSON.stringify(projected)).not.toContain("credentials/setup?grant=");
    expect(JSON.stringify(projected)).toContain("no_longer_pending");
  });

  it("preserves the prompt while the same elicitation is still pending", () => {
    const elicitationId = "elicitation-live";
    const raw = {
      conversation_id: "conv1",
      status: "awaiting_input" as const,
      pending_elicitation_id: elicitationId,
      events: [{ type: "elicit_request", elicitation_id: elicitationId }],
    };

    const projected = projectTurnEnvelopeForClient(raw, {
      pending_elicitation_id: elicitationId,
    });

    expect(projected).toEqual(raw);
  });
});
