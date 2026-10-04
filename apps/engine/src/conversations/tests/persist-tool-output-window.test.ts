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

const HEAVY_PAYLOAD = "x".repeat(20_000);

function isoFor(turn: number, kind: "user" | "tool"): Date {
  const base = new Date("2026-04-01T00:00:00.000Z").getTime();
  return new Date(base + turn * 60_000 + (kind === "tool" ? 1_000 : 0));
}

beforeAll(async () => {
  ctx = await createLlmTestCtx("persist-tool-output-window");
  const [conv] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = conv!.id;

  for (let turn = 0; turn < 5; turn++) {
    await ctx.testDb.db.insert(conversationMessages).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      role: "user",
      content: { text: `turn ${turn} request` },
      created_at: isoFor(turn, "user"),
    });
    await ctx.testDb.db.insert(conversationToolCalls).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool: "inspect_workflow_draft",
      input: { turn },
      output: { ok: true, turn, payload: HEAVY_PAYLOAD },
      created_at: isoFor(turn, "tool"),
    });
  }
});

describe("buildModelMessages — tool output sliding window", () => {
  it("elides bulky tool outputs older than the verbatim window", async () => {
    const msgs = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conversation_id);
    const toolResults = msgs.filter((m) => m.role === "tool") as Array<{
      content: Array<{ output: { value: Record<string, unknown> } }>;
    }>;
    expect(toolResults.length).toBe(5);

    const payloads = toolResults.map((r) => r.content[0]?.output.value ?? {});
    const turnsByPosition = payloads.map((p) =>
      typeof (p as { turn?: unknown }).turn === "number" ? (p as { turn: number }).turn : null,
    );
    expect(payloads[0]).toMatchObject({ _elided: true, _tool: "inspect_workflow_draft" });
    expect(payloads[1]).toMatchObject({ _elided: true, _tool: "inspect_workflow_draft" });
    expect(turnsByPosition[2]).toBe(2);
    expect(turnsByPosition[3]).toBe(3);
    expect(turnsByPosition[4]).toBe(4);
  });

  it("elided stubs keep a usable _raw_ref + _note for re-fetch", async () => {
    const msgs = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conversation_id);
    const elided = (
      msgs.filter((m) => m.role === "tool") as Array<{
        content: Array<{ output: { value: Record<string, unknown> } }>;
      }>
    )
      .map((r) => r.content[0]?.output.value)
      .filter(
        (p): p is Record<string, unknown> => !!p && (p as { _elided?: boolean })._elided === true,
      );
    expect(elided.length).toBe(2);
    for (const stub of elided) {
      expect(typeof stub._raw_ref).toBe("string");
      expect((stub._raw_ref as string).startsWith("raw_")).toBe(true);
      expect(typeof stub._note).toBe("string");
      expect(stub._note as string).toMatch(/get_raw_result/);
    }
  });

  it("the rebuilt prompt fits comfortably under 200K chars", async () => {
    const msgs = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conversation_id);
    const totalChars = JSON.stringify(msgs).length;
    expect(totalChars).toBeLessThan(120_000);
  });
});
