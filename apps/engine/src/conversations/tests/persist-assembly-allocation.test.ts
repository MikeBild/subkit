// Allocation + projection pins for buildModelMessages (issue: multi-GB
// per-turn transient in model-message assembly).
//
// Two regressions guarded here:
//
//   1. Tool-role `conversation_messages` rows are full audit copies of
//      every tool output, but replay reads only decision/tool/reason from
//      them — the SQL projection must keep the bulk out of the JS heap
//      while decision notes still replay.
//
//   2. The total JSON.stringify work during one assembly must stay a
//      small multiple of the verbatim-window payload bytes. Pre-fix the
//      truncation pass alone stringified ~payload × depth per output and
//      the elide-size check re-stringified every verbatim output.

import { beforeAll, describe, expect, it } from "bun:test";
import {
  conversationMessages,
  conversations,
  conversationToolCalls,
} from "../../db/schema/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { buildModelMessages } from "../persist.ts";

let ctx: LlmTestCtx;
let conversation_id: string;
let verbatimPayloadBytes = 0;

// ~300KB nested payload per tool call.
function heavyPayload(turn: number): unknown {
  return {
    ok: true,
    turn,
    step_trace: Array.from({ length: 24 }, (_, i) => ({
      id: `step-${turn}-${i}`,
      request: { url: `https://api.example.com/${i}`, body: { q: "x".repeat(300) } },
      response: {
        rows: Array.from({ length: 10 }, (_, j) => ({
          j,
          value: "z".repeat(280),
          nested: { deep: { text: "w".repeat(240) } },
        })),
      },
    })),
  };
}

function isoFor(turn: number, offsetMs: number): Date {
  return new Date(new Date("2026-04-01T00:00:00.000Z").getTime() + turn * 60_000 + offsetMs);
}

beforeAll(async () => {
  ctx = await createLlmTestCtx("persist-assembly-allocation");
  const [conv] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = conv!.id;

  // 4 user turns, one heavy tool call each; the last 3 turns are inside
  // the verbatim window. Every call also gets its tool-role audit copy —
  // the way invoke.ts persists them.
  for (let turn = 0; turn < 4; turn++) {
    await ctx.testDb.db.insert(conversationMessages).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      role: "user",
      content: { text: `turn ${turn} request` },
      created_at: isoFor(turn, 0),
    });
    const output = heavyPayload(turn);
    if (turn >= 1) verbatimPayloadBytes += JSON.stringify(output).length;
    await ctx.testDb.db.insert(conversationToolCalls).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool: "run_workflow",
      input: { turn },
      output,
      created_at: isoFor(turn, 1_000),
    });
    await ctx.testDb.db.insert(conversationMessages).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      role: "tool",
      content: { tool: "run_workflow", output },
      created_at: isoFor(turn, 1_100),
    });
  }
  // One decision note — the ONLY thing replay reads from tool-role rows.
  await ctx.testDb.db.insert(conversationMessages).values({
    tenant_id: ctx.tenant_id,
    conversation_id,
    role: "tool",
    content: { tool: "ask_user_confirm", decision: "approved", reason: "looks right" },
    created_at: isoFor(3, 2_000),
  });
});

describe("buildModelMessages — audit-copy projection + allocation bound", () => {
  it("decision notes replay; bare tool-role audit copies contribute nothing", async () => {
    const msgs = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conversation_id);
    // The decision note becomes a user-role continuation line.
    const decisionLines = msgs.filter(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("decision=approved"),
    );
    expect(decisionLines).toHaveLength(1);
    expect((decisionLines[0]!.content as string).includes("looks right")).toBe(true);
    // Real tool results come from conversation_tool_calls (4 calls), not
    // from the audit copies.
    const toolResults = msgs.filter((m) => m.role === "tool");
    expect(toolResults).toHaveLength(4);
  });

  it("stringify work during one assembly stays under 3× the verbatim payload bytes", async () => {
    const orig = JSON.stringify.bind(JSON);
    let bytes = 0;
    // biome-ignore lint/suspicious/noExplicitAny: test-local shim
    (JSON as any).stringify = function counted(value: unknown, ...rest: unknown[]) {
      // biome-ignore lint/suspicious/noExplicitAny: passthrough
      const s = (orig as any)(value, ...rest);
      if (typeof s === "string") bytes += s.length;
      return s;
    };
    let msgs: Awaited<ReturnType<typeof buildModelMessages>>;
    try {
      msgs = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conversation_id);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (JSON as any).stringify = orig;
    }
    expect(msgs.length).toBeGreaterThan(0);
    expect(verbatimPayloadBytes).toBeGreaterThan(400_000);
    // Pre-fix this was ~payload × depth from the truncation pass plus a
    // full re-stringify per verbatim output from the elide-size check —
    // several multiples over this bound.
    expect(bytes).toBeLessThan(3 * verbatimPayloadBytes);
  });
});
